import { Copy, Download, KeyRound, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, errMsg, type TwoFactorStatus, type User } from '../api';
import { useStudio } from '../store';
import { QrCode } from './QrCode';
import { Modal, Spinner, useUi } from './ui';

/** The authenticator app's 6-digit code (spaces allowed, nothing else). */
function CodeInput({ value, onChange, allowRecovery }: { value: string; onChange: (v: string) => void; allowRecovery?: boolean }) {
  return (
    <input
      className="input mono"
      autoComplete="one-time-code"
      inputMode={allowRecovery ? 'text' : 'numeric'}
      placeholder={allowRecovery ? '123456 or a recovery code' : '123456'}
      maxLength={allowRecovery ? 40 : 7}
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(allowRecovery ? e.target.value : e.target.value.replace(/[^0-9 ]/g, ''))}
    />
  );
}

function RecoveryCodes({ codes, username, saved, setSaved, onDone }: { codes: string[]; username: string; saved: boolean; setSaved: (v: boolean) => void; onDone: () => void }) {
  const ui = useUi();
  const { meta } = useStudio();
  const text = `${meta?.appName ?? 'Everything Studio'} — recovery codes for @${username}\nEach code works once, instead of the code from the authenticator app.\n\n${codes.join('\n')}\n`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      ui.toast('Recovery codes copied');
    } catch {
      ui.toast('Copying is not allowed here — download them or write them down', 'error');
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `recovery-codes-${username}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="stack">
      <div className="notice warn">
        <KeyRound size={18} style={{ flex: 'none' }} />
        <div>
          <b>Save these recovery codes now — they are shown only this once.</b> If your phone is lost, each code signs you in once instead of the code from the app.
          Keep them somewhere safe and apart from your password (a password manager, or printed). Lost them? Make new ones here any time with your password and a
          code from the app.
        </div>
      </div>
      <div
        className="mono"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '6px 16px', padding: 14, background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 15 }}
      >
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="row wrap">
        <button className="btn" onClick={() => void copy()}>
          <Copy size={14} /> Copy
        </button>
        <button className="btn" onClick={download}>
          <Download size={14} /> Download .txt
        </button>
      </div>
      <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved my recovery codes
      </label>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary" disabled={!saved} onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/** Escape, the X and a click beside the dialog: ignored while a request runs or unsaved codes are shown. */
function guardedClose(busy: boolean, unsavedCodes: boolean, close: () => void, ui: ReturnType<typeof useUi>) {
  if (busy) return;
  if (unsavedCodes) {
    ui.toast('Save your recovery codes first (copy or download them), then tick “I have saved my recovery codes”.', 'info');
    return;
  }
  close();
}

function SetupDialog({ onClose, onEnabled }: { onClose: () => void; onEnabled: (u: User) => void }) {
  const { user } = useStudio();
  const [step, setStep] = useState<'password' | 'scan' | 'codes'>('password');
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ secret: string; uri: string; setupToken: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ui = useUi();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    run(async () => {
      setSetup(await api<{ secret: string; uri: string; setupToken: string }>('/account/2fa/setup', { body: { password } }));
      setPassword('');
      setStep('scan');
    });
  const enable = () =>
    run(async () => {
      const r = await api<{ recoveryCodes: string[]; user: User }>('/account/2fa/enable', { body: { setupToken: setup!.setupToken, code } });
      setCodes(r.recoveryCodes);
      setStep('codes');
      onEnabled(r.user);
    });

  let body: ReactNode;
  if (step === 'password') {
    body = (
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <p className="muted small" style={{ margin: 0 }}>
          With two-step sign-in, logging in needs your password <i>and</i> a 6-digit code from an authenticator app on your phone (for example Aegis, 2FAS, Google
          Authenticator, Microsoft Authenticator, 1Password or Bitwarden). Someone who learns your password still cannot get in.
        </p>
        <div className="field" style={{ marginTop: 0 }}>
          <label className="label">Your password</label>
          <input className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" disabled={busy || !password}>
            {busy ? <Spinner size={14} /> : null} Continue
          </button>
        </div>
      </form>
    );
  } else if (step === 'scan' && setup) {
    body = (
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void enable();
        }}
      >
        <div className="row" style={{ gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <QrCode value={setup.uri} size={196} label="QR code for your authenticator app" />
          <div className="stack grow" style={{ minWidth: 220 }}>
            <ol className="muted small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
              <li>Open your authenticator app and add an account (usually “+” or “Scan a QR code”).</li>
              <li>Scan this code. Cannot scan? Choose “enter a setup key” and type the key below (time-based).</li>
              <li>Enter the 6-digit code the app shows.</li>
            </ol>
            <div>
              <div className="faint small">Setup key</div>
              <code className="code-inline" style={{ fontSize: 13, userSelect: 'all', overflowWrap: 'anywhere' }}>
                {setup.secret.match(/.{1,4}/g)?.join(' ')}
              </code>
            </div>
          </div>
        </div>
        <div className="field" style={{ marginTop: 0, maxWidth: 260 }}>
          <label className="label">Code from the app</label>
          <CodeInput value={code} onChange={setCode} />
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" disabled={busy || code.replace(/\s/g, '').length !== 6}>
            {busy ? <Spinner size={14} /> : <ShieldCheck size={14} />} Switch on
          </button>
        </div>
      </form>
    );
  } else {
    body = <RecoveryCodes codes={codes} username={user?.username ?? 'account'} saved={saved} setSaved={setSaved} onDone={onClose} />;
  }

  return (
    <Modal
      title="Set up two-step sign-in"
      icon={<Smartphone size={18} />}
      // not while a request runs (the codes would be lost), and the codes only once they are saved
      onClose={() => guardedClose(busy, step === 'codes' && !saved, onClose, ui)}
    >
      {body}
    </Modal>
  );
}

/** Password + a current code: to switch it off, or to replace the recovery codes. */
function ConfirmDialog({ mode, onClose, onDone }: { mode: 'disable' | 'codes'; onClose: () => void; onDone: (r: { user?: User; recoveryCodes?: string[] }) => void }) {
  const { user } = useStudio();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ui = useUi();

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ user?: User; recoveryCodes?: string[] }>(mode === 'disable' ? '/account/2fa/disable' : '/account/2fa/recovery-codes', {
        body: { password, code },
      });
      if (r.recoveryCodes) setCodes(r.recoveryCodes);
      onDone(r);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={mode === 'disable' ? 'Switch two-step sign-in off?' : 'New recovery codes'}
      icon={mode === 'disable' ? <ShieldOff size={18} /> : <KeyRound size={18} />}
      onClose={() => guardedClose(busy, !!codes && !saved, onClose, ui)}
    >
      {codes ? (
        <RecoveryCodes codes={codes} username={user?.username ?? 'account'} saved={saved} setSaved={setSaved} onDone={onClose} />
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="muted small" style={{ margin: 0 }}>
            {mode === 'disable'
              ? 'Logging in will need only your password again. Confirm with your password and a code from the app (or a recovery code).'
              : 'Makes 10 new recovery codes — the old ones stop working. Confirm with your password and a code from the app.'}
          </p>
          <div className="field" style={{ marginTop: 0 }}>
            <label className="label">Your password</label>
            <input className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="field" style={{ marginTop: 0 }}>
            <label className="label">Code from the app</label>
            <CodeInput value={code} onChange={setCode} allowRecovery />
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className={`btn ${mode === 'disable' ? 'danger' : 'primary'}`} disabled={busy || !password || !code.trim()}>
              {busy ? <Spinner size={14} /> : null} {mode === 'disable' ? 'Switch off' : 'Make new codes'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function TwoFactorCard() {
  const ui = useUi();
  const { setUser } = useStudio();
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [dialog, setDialog] = useState<'setup' | 'disable' | 'codes' | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api<TwoFactorStatus>('/account/2fa'));
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  }, [ui]);
  useEffect(() => {
    void load();
  }, [load]);

  const close = () => {
    setDialog(null);
    void load();
  };

  return (
    <div className="card" id="two-factor">
      <div className="card-head">
        <ShieldCheck size={18} color="var(--accent)" />
        <h2 className="grow">Two-step sign-in</h2>
        {status && <span className={`badge ${status.enabled ? 'ok' : ''}`}>{status.enabled ? 'on' : 'off'}</span>}
      </div>
      <div className="card-body stack">
        {!status ? (
          <Spinner />
        ) : status.enabled ? (
          <>
            <p className="muted small" style={{ margin: 0 }}>
              Logging in asks for a code from your authenticator app after your password
              {status.enabledAt ? ` — on since ${new Date(status.enabledAt).toLocaleDateString()}` : ''}.
            </p>
            {status.failedAttempts > 0 && (
              <div className={`notice ${status.locked ? 'error' : 'warn'}`}>
                <ShieldOff size={18} style={{ flex: 'none' }} />
                <div>
                  {status.failedAttempts} wrong code{status.failedAttempts === 1 ? '' : 's'} in a row
                  {status.lastFailedAt ? ` (last ${new Date(status.lastFailedAt).toLocaleString()})` : ''}.{' '}
                  {status.locked
                    ? 'Codes from the app are blocked until you sign in with a recovery code. '
                    : 'After 10 wrong codes in a row only recovery codes are accepted. '}
                  If that was not you, someone knows your password — change it now.
                </div>
              </div>
            )}
            <div className={`notice ${status.recoveryCodesLeft <= 2 ? 'warn' : 'info'}`}>
              <KeyRound size={18} style={{ flex: 'none' }} />
              <div>
                {status.recoveryCodesLeft} of 10 recovery codes left.
                {status.recoveryCodesLeft <= 2 && ' Make new ones before they run out — without the app and without codes only an admin can let you in.'}
              </div>
            </div>
            <div className="row wrap">
              <button className="btn" onClick={() => setDialog('codes')}>
                <KeyRound size={14} /> New recovery codes
              </button>
              <button className="btn ghost" onClick={() => setDialog('disable')}>
                <ShieldOff size={14} /> Switch off
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted small" style={{ margin: 0 }}>
              Optional, recommended: after your password, logging in also asks for a 6-digit code from an authenticator app on your phone. A stolen password alone is
              then not enough.
            </p>
            <div>
              <button className="btn primary" onClick={() => setDialog('setup')}>
                <Smartphone size={14} /> Set up two-step sign-in
              </button>
            </div>
          </>
        )}
      </div>
      {dialog === 'setup' && (
        <SetupDialog
          onClose={close}
          onEnabled={(u) => {
            setUser(u);
            ui.toast('Two-step sign-in is on — other sessions of your account were logged out');
          }}
        />
      )}
      {(dialog === 'disable' || dialog === 'codes') && (
        <ConfirmDialog
          mode={dialog}
          onClose={close}
          onDone={(r) => {
            if (r.user) {
              setUser(r.user);
              ui.toast('Two-step sign-in is off');
              close();
            }
          }}
        />
      )}
    </div>
  );
}
