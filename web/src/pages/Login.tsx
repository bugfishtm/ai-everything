import { LogIn, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api, errMsg, type User } from '../api';
import { AreaIcon, Spinner } from '../components/ui';
import { useStudio } from '../store';

export function LoginPage() {
  const { user, meta, setUser } = useStudio();
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

  const from = (loc.state as { from?: string } | null)?.from ?? '/';
  if (user) return <Navigate to={from} replace />;
  const canRegister = firstRun || meta?.registrationOpen;

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r =
        mode === 'login'
          ? await api<{ user: User }>('/auth/login', { body: { login, password } })
          : await api<{ user: User }>('/auth/register', {
              body: { email, username, displayName: displayName || undefined, password, setupCode: firstRun && meta?.setupCode ? setupCode : undefined },
            });
      setUser(r.user);
      nav(from, { replace: true });
    } catch (err) {
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
          {mode === 'login' ? (
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
          <button className="btn primary lg" style={{ width: '100%', marginTop: 20 }} disabled={busy}>
            {busy ? <Spinner size={16} /> : mode === 'login' ? <LogIn size={17} /> : <UserPlus size={17} />}
            {mode === 'login' ? 'Log in' : firstRun ? 'Create admin account' : 'Create account'}
          </button>
        </form>
        {!firstRun && (
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
