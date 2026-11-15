import { ArrowLeft, LogIn, ShieldCheck, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, errMsg, type LoginResult, type User } from '../api';
import { AreaIcon, Spinner, useUi } from '../components/ui';
import { useStudio } from '../store';

export function LoginPage() {
  const { user, meta, setUser } = useStudio();
  const ui = useUi();
  const nav = useNavigate();
  const loc = useLocation();
  const firstRun = meta && !meta.hasUsers;
  const [mode, setMode] = useState<'login' | 'register'>(firstRun ? 'register' : 'login');
  const [login, setLogin] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // two-step sign-in: after the password, a code from the authenticator app (or a recovery code)
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);

  const from = (loc.state as { from?: string } | null)?.from ?? '/';
  // only complete codes are sent: every attempt counts against the account
  const codeComplete = useRecovery ? code.replace(/[^a-z0-9]/gi, '').length === 12 : code.replace(/\s/g, '').length === 6;
  if (user) return <Navigate to={from} replace />;
  const canRegister = firstRun || meta?.registrationOpen;

  const backToPassword = () => {
    setTicket(null);
    setCode('');
    setUseRecovery(false);
    setPassword('');
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      if (ticket) {
        const r = await api<{ user: User; recoveryCodesLeft?: number; failedAttempts?: number }>('/auth/login/2fa', { body: { ticket, code } });
        if (r.failedAttempts) {
          // someone else may know the password: say so while the owner is here
          ui.toast(
            `${r.failedAttempts} wrong code${r.failedAttempts === 1 ? ' was' : 's were'} entered for your account since your last sign-in. If that was not you, change your password now.`,
            'error',
          );
        }
        if (r.recoveryCodesLeft !== undefined) {
          // remind them right away: the codes run out
          ui.toast(
            r.recoveryCodesLeft > 0
              ? `You signed in with a recovery code. ${r.recoveryCodesLeft} left — make new ones under Account & AI → Two-step sign-in.`
              : 'You used your last recovery code. Make new ones now under Account & AI → Two-step sign-in.',
            'error',
          );
        }
        setUser(r.user);
        nav(from, { replace: true });
        return;
      }
      if (mode === 'login') {
        const r = await api<LoginResult>('/auth/login', { body: { login, password } });
        if (r.twoFactor) {
          setTicket(r.ticket);
          setPassword('');
          setCode('');
          return;
        }
        setUser(r.user);
      } else {
        const r = await api<{ user: User }>('/auth/register', {
          body: { email, username, displayName: displayName || undefined, password, setupCode: firstRun && meta?.setupCode ? setupCode : undefined },
        });
        setUser(r.user);
      }
      nav(from, { replace: true });
    } catch (err) {
      // the code step took too long (or the password changed meanwhile): start over
      if (ticket && err instanceof ApiError && err.code === 'ticket_expired') backToPassword();
      // codes from the app are blocked after too many wrong ones: a recovery code is the way in
      if (ticket && err instanceof ApiError && err.code === 'locked') {
        setUseRecovery(true);
        setCode('');
      }
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="card auth-card">
        <div className="center" style={{ marginBottom: 8 }}>
          <span className="brand-mark" style={{ width: 46, height: 46, borderRadius: 13 }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <path d="M6 7h12M6 12h8M6 17h12" />
            </svg>
          </span>
        </div>
        <h1 style={{ textAlign: 'center', fontSize: 22 }}>{meta?.appName ?? 'Everything Studio'}</h1>
        <p className="muted" style={{ textAlign: 'center', marginTop: 6 }}>
          Music, images, 3D, games and apps — a self-hosted creative studio that runs Claude Code.
        </p>
        <div className="auth-areas">
          {['music', 'image', 'box', 'clapperboard', 'gamepad', 'smartphone', 'monitor', 'globe'].map((i) => (
            <AreaIcon key={i} icon={i} size={17} />
          ))}
        </div>

        {firstRun && (
          <div className="notice info" style={{ margin: '14px 0 0' }}>
            Welcome! Create the first account — it becomes the administrator.
          </div>
        )}

        <form
          style={{ marginTop: 18 }}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {error && <div className="form-error" style={{ marginBottom: 14 }}>{error}</div>}
          {ticket ? (
            <>
              <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <ShieldCheck size={20} color="var(--accent)" style={{ flex: 'none', marginTop: 2 }} />
                <div className="muted small" style={{ lineHeight: 1.5 }}>
                  {useRecovery
                    ? 'Enter one of the recovery codes you saved when you switched two-step sign-in on. Each code works once.'
                    : 'Open your authenticator app and enter the 6-digit code it shows for this Studio.'}
                </div>
              </div>
              <div className="field">
                <label className="label" htmlFor="login-code">
                  {useRecovery ? 'Recovery code' : 'Code from the app'}
                </label>
                {useRecovery ? (
                  <input
                    id="login-code"
                    key="recovery"
                    className="input mono"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="xxxx-xxxx-xxxx"
                    maxLength={40}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                ) : (
                  <input
                    id="login-code"
                    key="totp"
                    className="input mono"
                    autoFocus
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    placeholder="123456"
                    maxLength={7}
                    style={{ fontSize: 20, letterSpacing: '0.3em', textAlign: 'center' }}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, ''))}
                  />
                )}
              </div>
            </>
          ) : mode === 'login' ? (
            <>
              <div className="field">
                <label className="label">Email or username</label>
                <input className="input" autoFocus autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} />
              </div>
              <div className="field">
                <label className="label">Password</label>
                <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label className="label">Email</label>
                <input className="input" type="email" autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="row" style={{ gap: 10, marginTop: 14 }}>
                <div className="field grow" style={{ marginTop: 0 }}>
                  <label className="label">Username</label>
                  <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
                </div>
                <div className="field grow" style={{ marginTop: 0 }}>
                  <label className="label">Display name</label>
                  <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="optional" />
                </div>
              </div>
              <div className="field">
                <label className="label">Password</label>
                <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <div className="hint">At least 8 characters.</div>
              </div>
              {firstRun && meta?.setupCode && (
                <div className="field">
                  <label className="label">Setup code</label>
                  <input className="input mono" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} placeholder="XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false} />
                  <div className="hint">
                    Shows that this is your server: the code is in its log — <code className="code-inline">docker compose logs studio</code>, look for “setup code”.
                  </div>
                </div>
              )}
            </>
          )}
          <button className="btn primary lg" style={{ width: '100%', marginTop: 20 }} disabled={busy || (!!ticket && !codeComplete)}>
            {busy ? <Spinner size={16} /> : ticket ? <ShieldCheck size={17} /> : mode === 'login' ? <LogIn size={17} /> : <UserPlus size={17} />}
            {ticket ? 'Verify' : mode === 'login' ? 'Log in' : firstRun ? 'Create admin account' : 'Create account'}
          </button>
        </form>
        {ticket && (
          <div className="row small" style={{ justifyContent: 'space-between', marginTop: 16, gap: 10, flexWrap: 'wrap' }}>
            <a
              href="#back"
              className="row"
              style={{ gap: 4 }}
              onClick={(e) => {
                e.preventDefault();
                backToPassword();
                setError('');
              }}
            >
              <ArrowLeft size={14} /> Back
            </a>
            <a
              href="#recovery"
              onClick={(e) => {
                e.preventDefault();
                setUseRecovery(!useRecovery);
                setCode('');
                setError('');
              }}
            >
              {useRecovery ? 'Use the code from the app' : 'Lost your phone? Use a recovery code'}
            </a>
          </div>
        )}
        {!firstRun && !ticket && (
          <div className="center small muted" style={{ marginTop: 16 }}>
            {mode === 'login' ? (
              canRegister ? (
                <span>
                  New here?{' '}
                  <a href="#register" onClick={(e) => { e.preventDefault(); setMode('register'); setError(''); }}>
                    Create an account
                  </a>
                </span>
              ) : (
                <span>Accounts are created by an administrator.</span>
              )
            ) : (
              <span>
                Already registered?{' '}
                <a href="#login" onClick={(e) => { e.preventDefault(); setMode('login'); setError(''); }}>
                  Log in
                </a>
              </span>
            )}
          </div>
        )}
      </div>
      <p className="faint small" style={{ textAlign: 'center', maxWidth: 420, margin: '14px auto 0', lineHeight: 1.5 }}>
        ai-everything is independent open-source software, not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic,
        PBC; Claude Code is used under Anthropic's terms with your own account.
      </p>
    </div>
  );
}
