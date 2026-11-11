// HTTPS of one host name: its certificate (automatic, uploaded, self-signed) and how HTTP behaves.
// Used in a project's Website tab (per domain) and in Admin → HTTPS (every host).
import { Download, FileKey2, Lock, LockOpen, RefreshCw, ShieldAlert, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, errMsg, type TlsHosting, type TlsInfo, type TlsMode } from '../api';
import { cls } from '../util';
import { Modal, Spinner, useUi } from './ui';

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '?');

/** "HTTPS · 82 days", "certificate pending" … as a coloured badge */
export function TlsBadge({ tls }: { tls?: TlsInfo | null }) {
  if (!tls) return null;
  const left = tls.daysLeft;
  const map: Record<TlsInfo['status'], [string, string]> = {
    active: [left !== null && left < 15 ? `HTTPS · ${Math.max(0, left)} days left` : 'HTTPS', left !== null && left < 15 ? 'warn' : 'ok'],
    pending: ['certificate pending', 'warn'],
    error: ['certificate failed', 'danger'],
    expired: ['certificate expired', 'danger'],
    none: ['no certificate', ''],
    off: ['HTTP only', ''],
  };
  const [label, tone] = map[tls.status];
  const title = tls.status === 'active' ? `${tls.issuer ?? 'certificate'} — valid until ${day(tls.notAfter)}` : (tls.error ?? undefined);
  return (
    <span className={cls('badge', tone)} title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {tls.status === 'active' ? <Lock size={11} /> : tls.status === 'pending' ? <Spinner size={11} /> : tls.status === 'error' || tls.status === 'expired' ? <ShieldAlert size={11} /> : <LockOpen size={11} />}
      {label}
    </span>
  );
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(new Error(`Cannot read ${file.name}`));
    r.readAsText(file);
  });
}

/** Paste or pick the certificate (with its chain) and the private key. */
export function UploadCertificate({ host, base, onClose, onDone }: { host: string; base: string; onClose: () => void; onDone: () => void | Promise<void> }) {
  const ui = useUi();
  const [cert, setCert] = useState('');
  const [key, setKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const certFile = useRef<HTMLInputElement>(null);
  const keyFile = useRef<HTMLInputElement>(null);
  const encrypted = /ENCRYPTED/.test(key);

  const pick = async (files: FileList | null, set: (v: string) => void) => {
    const f = files?.[0];
    if (!f) return;
    if (f.size > 200_000) return setError(`${f.name} is too large for a PEM file`);
    try {
      const text = await readFile(f);
      // one file with both parts: split it
      if (set === setCert && /PRIVATE KEY-----/.test(text) && !key) {
        const m = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/.exec(text);
        if (m) setKey(m[0]);
      }
      set(text);
      setError('');
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`${base}/certificate`, { method: 'PUT', body: { cert, key, ...(passphrase ? { passphrase } : {}) } });
      ui.toast(`Certificate for ${host} installed`);
      await onDone();
      onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Certificate for ${host}`}
      icon={<FileKey2 size={18} color="var(--accent)" />}
      size="medium"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || cert.trim().length < 50 || key.trim().length < 50} onClick={() => void save()}>
            {busy ? <Spinner size={14} /> : <Upload size={14} />} Install certificate
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="muted small">
          PEM text as you get it from your certificate provider: the certificate for <b>{host}</b> followed by its intermediate certificates (often called
          “full chain”), and the matching private key. The key is stored encrypted and never shown again.
        </div>
        <div className="field">
          <div className="row" style={{ gap: 8 }}>
            <label className="label grow" style={{ margin: 0 }}>
              Certificate (+ chain)
            </label>
            <button className="btn sm" onClick={() => certFile.current?.click()}>
              <Upload size={13} /> Choose file
            </button>
            <input ref={certFile} type="file" hidden accept=".pem,.crt,.cer,.txt" onChange={(e) => void pick(e.target.files, setCert)} />
          </div>
          <textarea
            className="textarea mono"
            rows={6}
            spellCheck={false}
            placeholder={'-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----'}
            value={cert}
            onChange={(e) => setCert(e.target.value)}
            style={{ fontSize: 11.5, marginTop: 6 }}
          />
        </div>
        <div className="field">
          <div className="row" style={{ gap: 8 }}>
            <label className="label grow" style={{ margin: 0 }}>
              Private key
            </label>
            <button className="btn sm" onClick={() => keyFile.current?.click()}>
              <Upload size={13} /> Choose file
            </button>
            <input ref={keyFile} type="file" hidden accept=".pem,.key,.txt" onChange={(e) => void pick(e.target.files, setKey)} />
          </div>
          <textarea
            className="textarea mono"
            rows={5}
            spellCheck={false}
            placeholder={'-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            style={{ fontSize: 11.5, marginTop: 6 }}
          />
        </div>
        {encrypted && (
          <div className="field">
            <label className="label">Passphrase of the key</label>
            <input className="input" type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </div>
        )}
        {error && <div className="notice error">{error}</div>}
      </div>
    </Modal>
  );
}

/**
 * Settings and actions for one host. `base` is the API path of the host:
 * /sites/<id>/domains/<host>/tls or /admin/tls/hosts/<host>.
 */
export function TlsControls({
  tls,
  base,
  hosting,
  onChanged,
  wildcard,
}: {
  tls: TlsInfo;
  base: string;
  hosting: Pick<TlsHosting, 'auto' | 'ca'>;
  onChanged: () => void | Promise<void>;
  wildcard?: boolean;
}) {
  const ui = useUi();
  const [busy, setBusy] = useState('');
  const [upload, setUpload] = useState(false);

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) ui.toast(done);
      await onChanged();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setBusy('');
    }
  };
  const patch = (body: { mode?: TlsMode; forceHttps?: boolean; hsts?: boolean }, done?: string) => run('patch', () => api(base, { method: 'PATCH', body }), done);

  const setMode = (mode: TlsMode) => {
    if (mode === 'custom' && tls.source !== 'custom') {
      setUpload(true); // installing the certificate switches the mode
      return;
    }
    void patch({ mode }, mode === 'off' ? `${tls.host} is served over HTTP only` : undefined);
  };

  const removeCert = async () => {
    const ok = await ui.confirm({
      title: `Remove the certificate of ${tls.host}?`,
      body:
        tls.mode === 'auto'
          ? 'A new one is requested automatically.'
          : wildcard
            ? 'Hosts that used this wildcard certificate fall back to their own.'
            : 'The host is served over HTTP until it has a certificate again.',
      confirm: 'Remove certificate',
      danger: true,
    });
    if (ok) await run('remove', () => api(`${base}/certificate`, { method: 'DELETE' }));
  };

  const hasCert = !!tls.source;
  const sourceLabel = tls.source === 'acme' ? 'automatic' : tls.source === 'custom' ? 'uploaded' : tls.source === 'selfsigned' ? 'self-signed' : (tls.source ?? '');

  return (
    <div className="stack" style={{ gap: 8, padding: '10px 12px', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 8 }}>
      <div className="row wrap" style={{ gap: 12 }}>
        <select className="select" style={{ width: 'auto', minWidth: 230 }} value={tls.mode} disabled={!!busy} onChange={(e) => setMode(e.target.value as TlsMode)}>
          {!wildcard && <option value="auto">Automatic certificate ({hosting.ca})</option>}
          <option value="custom">My own certificate (upload)</option>
          {!wildcard && <option value="selfsigned">Self-signed (browsers show a warning)</option>}
          {!wildcard && <option value="off">Off — HTTP only</option>}
        </select>
        {!wildcard && tls.mode !== 'off' && (
          <>
            <label className="row small" style={{ gap: 6 }} title="Visitors who open http:// are sent to https:// once a certificate is active">
              <input type="checkbox" checked={tls.forceHttps} disabled={!!busy} onChange={(e) => void patch({ forceHttps: e.target.checked })} />
              Redirect HTTP to HTTPS
            </label>
            <label className="row small" style={{ gap: 6 }} title="Strict-Transport-Security: browsers remember for a year to use HTTPS only. Switch on when HTTPS works reliably.">
              <input type="checkbox" checked={tls.hsts} disabled={!!busy} onChange={(e) => void patch({ hsts: e.target.checked })} />
              HSTS
            </label>
          </>
        )}
      </div>

      {hasCert ? (
        <div className="small">
          <b>{tls.issuer ?? 'Certificate'}</b> <span className="faint">({sourceLabel})</span> · valid until {day(tls.notAfter)}
          {tls.daysLeft !== null && <span style={tls.daysLeft < 15 ? { color: 'var(--warn)' } : undefined}> ({tls.daysLeft < 0 ? 'expired' : `${tls.daysLeft} days left`})</span>}
          {tls.names.length > 0 && <span className="faint"> · for {tls.names.slice(0, 4).join(', ')}{tls.names.length > 4 ? ` +${tls.names.length - 4}` : ''}</span>}
          {tls.viaWildcard && <span className="faint"> · from the wildcard certificate {tls.viaWildcard}</span>}
        </div>
      ) : (
        tls.mode !== 'off' && (
          <div className="small muted">
            {tls.status === 'pending'
              ? 'The certificate is being requested — this takes up to a minute.'
              : tls.mode === 'auto' && tls.error
                ? `No certificate yet — the last request failed${tls.attempts > 1 ? ` (${tls.attempts} tries)` : ''}. The Studio tries again by itself; fix the cause below, then “Request now”.`
                : tls.mode === 'auto'
                ? hosting.auto
                  ? 'No certificate yet. It is requested as soon as the website is live and the domain points to this server.'
                  : 'Automatic certificates are not switched on on this Studio yet — an admin does that under Admin → HTTPS. Until then: upload a certificate or use a self-signed one.'
                : tls.mode === 'custom'
                  ? 'No certificate uploaded yet.'
                  : 'No certificate yet.'}
          </div>
        )
      )}

      {tls.error && (
        <div className="notice warn small" style={{ margin: 0 }}>
          <span>
            {tls.error}
            {tls.nextTryAt && tls.mode === 'auto' && ` — next try ${new Date(tls.nextTryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
          </span>
        </div>
      )}

      {tls.mode !== 'off' && (
        <div className="row wrap" style={{ gap: 8 }}>
          {(tls.mode === 'auto' || tls.mode === 'selfsigned') && (
            <button className="btn sm" disabled={!!busy || (tls.mode === 'auto' && !hosting.auto)} onClick={() => void run('issue', () => api(`${base}/issue`, { body: {} }), 'Certificate requested')}>
              {busy === 'issue' ? <Spinner size={14} /> : <RefreshCw size={14} />} {hasCert ? 'Renew now' : 'Request now'}
            </button>
          )}
          <button className="btn sm" disabled={!!busy} onClick={() => setUpload(true)}>
            <Upload size={14} /> Upload certificate
          </button>
          {hasCert && !tls.viaWildcard && (
            <a className="btn sm" href={`/api${base}/certificate`} title="The public certificate with its chain (PEM) — never the private key">
              <Download size={14} /> Download
            </a>
          )}
          {hasCert && !tls.viaWildcard && (
            <button className="btn sm ghost" disabled={!!busy} onClick={() => void removeCert()}>
              {busy === 'remove' ? <Spinner size={14} /> : <Trash2 size={14} />} Remove
            </button>
          )}
        </div>
      )}
      {upload && <UploadCertificate host={tls.host} base={base} onClose={() => setUpload(false)} onDone={onChanged} />}
    </div>
  );
}
