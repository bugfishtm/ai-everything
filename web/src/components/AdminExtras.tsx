// Admin cards: HTTPS (certificate authority, the Studio's own address, every certificate)
// and the instructions the admin gives to everyone's AI.
import { ChevronDown, ChevronRight, Lock, MessageSquareText, Plus, RefreshCw, Save } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, errMsg, type AcmeSettings, type Instruction, type TlsOverview } from '../api';
import { socket } from '../ws';
import { TlsBadge, TlsControls, UploadCertificate } from './Https';
import { InstructionsEditor } from './Instructions';
import { Spinner, useUi } from './ui';

const KIND_LABEL = { site: 'website', studio: 'this Studio', wildcard: 'wildcard' } as const;

export function HttpsAdminCard() {
  const ui = useUi();
  const [tls, setTls] = useState<TlsOverview | null>(null);
  const [acme, setAcme] = useState<AcmeSettings | null>(null);
  const [studioDomain, setStudioDomain] = useState('');
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState('');
  const [wildcard, setWildcard] = useState('');
  const [uploadFor, setUploadFor] = useState('');

  const apply = useCallback((t: TlsOverview, resetForms: boolean) => {
    setTls(t);
    if (resetForms) {
      setAcme(t.acme);
      setStudioDomain(t.studioDomain);
    }
  }, []);
  const load = useCallback(
    async (resetForms = false) => {
      try {
        apply((await api<{ tls: TlsOverview }>('/admin/tls')).tls, resetForms);
      } catch (err) {
        ui.toast(errMsg(err), 'error');
      }
    },
    [apply, ui],
  );
  useEffect(() => {
    void load(true);
    // certificates arrive in the background
    return socket.on((m) => {
      if (m.t === 'sites.changed') void load();
    });
  }, [load]);

  const save = async (key: string, body: Record<string, unknown>, done: string) => {
    setBusy(key);
    try {
      apply((await api<{ tls: TlsOverview }>('/admin/tls', { method: 'PUT', body })).tls, true);
      ui.toast(done);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setBusy('');
    }
  };

  const addWildcard = () => {
    const h = wildcard.trim().toLowerCase();
    if (!/^\*\.[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) return ui.toast('Write it like *.example.com', 'error');
    setUploadFor(h);
  };

  const portNote = tls && (tls.port !== 443 || tls.httpPort !== 80);
  const acmeDirty = !!tls && !!acme && JSON.stringify({ ...acme }) !== JSON.stringify({ ...tls.acme });
  const tosUrl = acme?.directory === 'custom' ? null : 'https://letsencrypt.org/repository/';

  return (
    <div className="card" id="https">
      <div className="card-head">
        <Lock size={18} color="var(--accent)" />
        <h2 className="grow">HTTPS &amp; certificates</h2>
        {tls && (
          <span className={`badge ${tls.enabled ? 'ok' : ''}`}>
            {tls.enabled ? `on · port ${tls.port}` : tls.externalProxy ? 'handled by a proxy' : 'off'}
          </span>
        )}
        <button className="btn sm ghost" onClick={() => void load()} title="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="card-body stack-lg">
        {!tls || !acme ? (
          <Spinner />
        ) : !tls.enabled ? (
          <div className="muted small">
            {tls.externalProxy
              ? 'A reverse proxy in front of this Studio terminates TLS and gets the certificates itself (SITES_HTTPS=true, e.g. the “https” profile with Caddy). Nothing to manage here.'
              : 'The built-in HTTPS is switched off (SITES_TLS=false or SITES_ENABLED=false). Switch it on to give every website domain its own certificate.'}
          </div>
        ) : (
          <>
            <p className="muted small" style={{ margin: 0 }}>
              Published websites are also served over HTTPS, with one certificate per domain: requested automatically from a certificate authority, uploaded by the owner, or
              self-signed. Owners manage their domains in the <b>Website</b> tab of a project.
              {portNote &&
                ` For public websites the HTTP port must be reachable from the internet as 80 and the HTTPS port as 443 — they are ${tls.httpPort} and ${tls.port} now (SITES_PORT=80, SITES_HTTPS_PORT=443, SITES_BIND=0.0.0.0).`}
            </p>

            <div className="stack">
              <div className="label" style={{ margin: 0 }}>
                Automatic certificates
              </div>
              <label className="row" style={{ gap: 8 }}>
                <input type="checkbox" checked={acme.enabled} onChange={(e) => setAcme({ ...acme, enabled: e.target.checked })} />
                Request and renew certificates automatically for domains that point to this server
              </label>
              <div className="row wrap" style={{ gap: 12, alignItems: 'flex-start' }}>
                <div className="field" style={{ flex: '1 1 240px', maxWidth: 340 }}>
                  <label className="label">Contact e-mail</label>
                  <input className="input" type="email" placeholder="you@example.com" value={acme.email} onChange={(e) => setAcme({ ...acme, email: e.target.value })} />
                  <div className="hint">The authority warns this address before a certificate expires. Optional.</div>
                </div>
                <div className="field" style={{ flex: '1 1 240px', maxWidth: 340, marginTop: 0 }}>
                  <label className="label">Certificate authority</label>
                  <select className="select" value={acme.directory} onChange={(e) => setAcme({ ...acme, directory: e.target.value as AcmeSettings['directory'] })}>
                    <option value="letsencrypt">Let's Encrypt</option>
                    <option value="letsencrypt-staging">Let's Encrypt — staging (for tests, not trusted by browsers)</option>
                    <option value="custom">Another ACME authority …</option>
                  </select>
                  {acme.directory === 'custom' && (
                    <input
                      className="input mono"
                      style={{ marginTop: 6 }}
                      placeholder="https://acme.example.com/directory"
                      value={acme.directoryUrl}
                      onChange={(e) => setAcme({ ...acme, directoryUrl: e.target.value })}
                    />
                  )}
                </div>
              </div>
              <label className="row" style={{ gap: 8 }}>
                <input type="checkbox" checked={acme.agreedTos} onChange={(e) => setAcme({ ...acme, agreedTos: e.target.checked, enabled: e.target.checked ? acme.enabled : false })} />
                <span>
                  I accept the terms of service of the certificate authority
                  {tosUrl && (
                    <>
                      {' '}
                      (
                      <a href={tosUrl} target="_blank" rel="noreferrer">
                        Let's Encrypt Subscriber Agreement
                      </a>
                      )
                    </>
                  )}
                </span>
              </label>
              <div className="row" style={{ gap: 10 }}>
                <button
                  className="btn sm primary"
                  disabled={!!busy || !acmeDirty}
                  onClick={() =>
                    void save(
                      'acme',
                      { acme: { enabled: acme.enabled, email: acme.email, directory: acme.directory, directoryUrl: acme.directoryUrl, agreedTos: acme.agreedTos } },
                      acme.enabled ? 'Saved — certificates are requested in the background' : 'Saved',
                    )
                  }
                >
                  {busy === 'acme' ? <Spinner size={14} /> : <Save size={14} />} Save
                </button>
                <span className="faint small">
                  {tls.acme.enabled && tls.acme.agreedTos ? `Active — ${tls.acme.ca}. Certificates are renewed 30 days before they expire.` : 'Not active: domains need an uploaded or self-signed certificate.'}
                </span>
              </div>
            </div>

            <div className="stack">
              <div className="label" style={{ margin: 0 }}>
                This Studio's own address
              </div>
              <div className="row wrap" style={{ gap: 8 }}>
                <input
                  className="input mono"
                  style={{ flex: '1 1 240px', maxWidth: 340 }}
                  placeholder="studio.example.com"
                  value={studioDomain}
                  onChange={(e) => setStudioDomain(e.target.value)}
                />
                <button
                  className="btn sm primary"
                  disabled={!!busy || studioDomain.trim().toLowerCase() === tls.studioDomain}
                  onClick={() => void save('domain', { studioDomain: studioDomain.trim() }, studioDomain.trim() ? 'Saved — the certificate is requested in the background' : 'Removed')}
                >
                  {busy === 'domain' ? <Spinner size={14} /> : <Save size={14} />} Save
                </button>
              </div>
              <div className="hint" style={{ marginTop: 0 }}>
                Optional. Point this host name to the server and the Studio itself answers at{' '}
                <code className="code-inline">
                  https://{tls.studioDomain || studioDomain.trim() || 'studio.example.com'}
                  {tls.port === 443 ? '' : `:${tls.port}`}
                </code>{' '}
                with its own certificate — no extra proxy needed. The plain address (port 8080) keeps working.
              </div>
            </div>

            <div className="stack">
              <div className="row" style={{ gap: 8 }}>
                <div className="label grow" style={{ margin: 0 }}>
                  Certificates ({tls.hosts.length})
                </div>
              </div>
              {!tls.hosts.length && <div className="muted small">No host yet — certificates appear here when websites get domains.</div>}
              {tls.hosts.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table className="table small">
                    <thead>
                      <tr>
                        <th>Host</th>
                        <th>For</th>
                        <th>Status</th>
                        <th>Certificate</th>
                        <th>Valid until</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {tls.hosts.map((h) => (
                        <Fragment key={h.host}>
                          <tr>
                            <td className="mono">{h.host}</td>
                            <td>{KIND_LABEL[h.kind ?? 'site']}</td>
                            <td>
                              <TlsBadge tls={h} />
                            </td>
                            <td>{h.issuer ?? <span className="faint">—</span>}</td>
                            <td>
                              {h.notAfter ? (
                                <>
                                  {new Date(h.notAfter).toLocaleDateString()} <span className="faint">({h.daysLeft} d)</span>
                                </>
                              ) : (
                                <span className="faint">—</span>
                              )}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <button className="btn sm ghost" onClick={() => setOpen(open === h.host ? '' : h.host)}>
                                {open === h.host ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Manage
                              </button>
                            </td>
                          </tr>
                          {open === h.host && (
                            <tr>
                              <td colSpan={6} style={{ paddingTop: 0 }}>
                                <TlsControls
                                  tls={h}
                                  base={`/admin/tls/hosts/${encodeURIComponent(h.host)}`}
                                  hosting={{ auto: tls.acme.enabled && tls.acme.agreedTos, ca: tls.acme.ca }}
                                  onChanged={() => load()}
                                  wildcard={h.kind === 'wildcard'}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <form
                className="row wrap"
                style={{ gap: 8 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  addWildcard();
                }}
              >
                <input className="input mono" style={{ flex: '1 1 240px', maxWidth: 340 }} placeholder="*.example.com" value={wildcard} onChange={(e) => setWildcard(e.target.value)} />
                <button className="btn sm" disabled={!wildcard.trim()}>
                  <Plus size={14} /> Add wildcard certificate
                </button>
              </form>
              <div className="hint" style={{ marginTop: 0 }}>
                A wildcard certificate you upload covers every host directly below its domain (<code className="code-inline">*.example.com</code> →{' '}
                <code className="code-inline">shop.example.com</code>) that has no certificate of its own — useful with a base domain for websites.
              </div>
            </div>
          </>
        )}
      </div>
      {uploadFor && (
        <UploadCertificate
          host={uploadFor}
          base={`/admin/tls/hosts/${encodeURIComponent(uploadFor)}`}
          onClose={() => setUploadFor('')}
          onDone={async () => {
            setWildcard('');
            await load();
          }}
        />
      )}
    </div>
  );
}

/** Instructions for everyone's AI on this Studio (house rules). */
export function InstructionsAdminCard() {
  const ui = useUi();
  const [items, setItems] = useState<Record<string, Instruction> | null>(null);
  const [meta, setMeta] = useState<{ areas: { id: string; name: string }[]; max: number } | null>(null);

  useEffect(() => {
    Promise.all([api<{ global: Record<string, Instruction> }>('/admin/instructions'), api<{ areas: { id: string; name: string }[]; max: number }>('/instructions')])
      .then(([g, m]) => {
        setItems(g.global);
        setMeta({ areas: m.areas, max: m.max });
      })
      .catch((err) => ui.toast(errMsg(err), 'error'));
  }, [ui]);

  return (
    <div className="card" id="instructions">
      <div className="card-head">
        <MessageSquareText size={18} color="var(--accent)" />
        <h2 className="grow">Instructions for every AI</h2>
        <span className="faint small">house rules of this Studio</span>
      </div>
      <div className="card-body stack">
        <div className="muted small">
          This text is part of the prompt of every AI session of every user — for everything, or only in one area. Use it for rules of your organisation (language, licences,
          what must not be built or published here). Users can read it on their Skills page and add their own instructions on top.
        </div>
        {!items || !meta ? (
          <Spinner />
        ) : (
          <InstructionsEditor
            items={items}
            areas={meta.areas}
            max={meta.max}
            save={async (scope, body, enabled) => {
              const r = await api<{ global: Record<string, Instruction> }>(`/admin/instructions/${scope}`, { method: 'PUT', body: { body, enabled } });
              setItems(r.global);
            }}
          />
        )}
      </div>
    </div>
  );
}
