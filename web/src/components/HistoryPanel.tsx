import { Download, GitCommitHorizontal, History, Package, Pencil, RotateCcw, Save, Tag, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, type Commit, type Project, type Release, type ReleasesData } from '../api';
import { cls, formatBytes, timeAgo } from '../util';
import { socket } from '../ws';
import { Empty, Modal, Spinner, useUi } from './ui';

type Bump = 'patch' | 'minor' | 'major' | 'custom';

/** The project's History tab: numbered releases (versioning) and the step-by-step history. */
export function HistoryPanel({ project, onVersion }: { project: Project; onVersion?: (version: string | null) => void }) {
  const ui = useUi();
  const [view, setView] = useState<'releases' | 'changes'>(project.version ? 'releases' : 'changes');
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [rel, setRel] = useState<ReleasesData | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [stat, setStat] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [editing, setEditing] = useState<Release | null>(null);
  const [startVersion, setStartVersion] = useState('0.1.0');

  const applyRel = useCallback(
    (r: ReleasesData) => {
      setRel(r);
      onVersion?.(r.versioning.enabled ? r.versioning.version : null);
    },
    [onVersion],
  );

  const load = useCallback(async () => {
    try {
      const [h, r] = await Promise.all([api<{ commits: Commit[] }>(`/projects/${project.id}/history`), api<ReleasesData>(`/projects/${project.id}/releases`)]);
      setCommits(h.commits);
      applyRel(r);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  }, [project.id, ui, applyRel]);

  useEffect(() => {
    void load();
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = socket.on((msg) => {
      if ((msg.t === 'project.changed' && msg.projectId === project.id) || (msg.t === 'chat.status' && msg.projectId === project.id && !msg.running)) {
        clearTimeout(t);
        t = setTimeout(() => void load(), 800);
      }
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [load, project.id]);

  const toggle = async (sha: string) => {
    setOpen(open === sha ? null : sha);
    if (!stat[sha]) {
      const r = await api<{ stat: string }>(`/projects/${project.id}/history/${sha}`).catch(() => ({ stat: '' }));
      setStat((s) => ({ ...s, [sha]: r.stat }));
    }
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const restore = async (c: Commit) => {
    const ok = await ui.confirm({
      title: 'Restore this version?',
      body: (
        <>
          The project files go back to <b>“{c.message}”</b> ({new Date(c.date).toLocaleString()}). The current state is saved first, so you can always come back.
        </>
      ),
      confirm: 'Restore',
    });
    if (!ok) return;
    await run(async () => {
      await api(`/projects/${project.id}/history/restore`, { body: { sha: c.sha } });
      ui.toast('Version restored');
      await load();
    });
  };

  const restoreRelease = async (r: Release) => {
    const ok = await ui.confirm({
      title: `Go back to version ${r.version}?`,
      body: 'The project files become what they were at this release. The current state is saved first, so you can always come back.',
      confirm: 'Restore',
    });
    if (!ok) return;
    await run(async () => {
      await api(`/projects/${project.id}/releases/${r.id}/restore`, { body: {} });
      ui.toast(`Files of version ${r.version} restored`);
      await load();
    });
  };

  const removeRelease = async (r: Release) => {
    const ok = await ui.confirm({
      title: `Delete release ${r.version}?`,
      body: 'Its notes, its tag and its copy of the exports are removed. The project files and the history stay as they are.',
      confirm: 'Delete release',
      danger: true,
    });
    if (!ok) return;
    await run(async () => {
      applyRel(await api<ReleasesData>(`/projects/${project.id}/releases/${r.id}`, { method: 'DELETE' }));
      ui.toast('Release deleted');
    });
  };

  const checkpoint = async () => {
    const message = await ui.prompt('Save the current state', 'Manual checkpoint', 'Description');
    if (message === null) return;
    await run(async () => {
      const r = await api<{ commit: { sha: string } | null }>(`/projects/${project.id}/checkpoint`, { body: { message } });
      ui.toast(r.commit ? 'Saved' : 'Nothing changed since the last save', r.commit ? 'ok' : 'info');
      await load();
    });
  };

  const setVersioning = async (enabled: boolean, version?: string) => {
    await run(async () => {
      applyRel(await api<ReleasesData>(`/projects/${project.id}/versioning`, { body: { enabled, version } }));
      ui.toast(enabled ? 'Versioning is on' : 'Versioning is off (the releases stay)');
    });
  };

  const v = rel?.versioning;
  const releaseTags = new Map((rel?.releases ?? []).filter((r) => r.sha).map((r) => [r.sha as string, r.version]));

  return (
    <div className="col" style={{ height: '100%', gap: 0 }}>
      <div className="preview-bar" style={{ flexWrap: 'wrap' }}>
        <History size={15} />
        <div className="tabs" style={{ border: 0 }}>
          <button className={cls('tab', view === 'releases' && 'active')} onClick={() => setView('releases')}>
            <Tag size={14} /> Releases{rel?.releases.length ? ` (${rel.releases.length})` : ''}
          </button>
          <button className={cls('tab', view === 'changes' && 'active')} onClick={() => setView('changes')}>
            <GitCommitHorizontal size={14} /> Every change
          </button>
        </div>
        <span className="spacer" />
        {busy && <Spinner size={14} />}
        {view === 'changes' ? (
          <button className="btn sm" onClick={checkpoint} disabled={busy}>
            <Save size={14} /> Save now
          </button>
        ) : (
          v?.enabled && (
            <button className="btn sm primary" onClick={() => setReleasing(true)} disabled={busy || project.busy} title={project.busy ? 'The AI is working — release when it is done' : undefined}>
              <Tag size={14} /> New release
            </button>
          )
        )}
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {view === 'releases' &&
          (!rel ? (
            <div className="center" style={{ padding: 30 }}>
              <Spinner />
            </div>
          ) : !v?.enabled ? (
            <div style={{ padding: 22, maxWidth: 640 }} className="stack">
              <h2 style={{ margin: 0 }}>Versioning</h2>
              <div className="muted">
                Give your work version numbers — 1.0.0, 1.1.0, 2.0.0. Every release keeps its notes, the project files as they were and a copy of the finished
                files in <code className="code-inline">exports/</code>, so any version can be downloaded or restored later. The project gets a{' '}
                <code className="code-inline">VERSION</code> file and a <code className="code-inline">CHANGELOG.md</code>, and the AI keeps them up to date.
              </div>
              <div className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
                <div className="field" style={{ margin: 0 }}>
                  <label className="label">Start at version</label>
                  <input className="input mono" style={{ width: 130 }} value={startVersion} onChange={(e) => setStartVersion(e.target.value)} placeholder="0.1.0" />
                </div>
                <button className="btn primary" disabled={busy || project.busy} onClick={() => void setVersioning(true, startVersion.trim() || '0.1.0')}>
                  <Tag size={15} /> Switch versioning on
                </button>
              </div>
              {rel.releases.length > 0 && <div className="hint">This project has {rel.releases.length} earlier release{rel.releases.length === 1 ? '' : 's'} — they are kept.</div>}
              {rel.releases.length > 0 && <ReleaseList rel={rel} project={project} busy={busy} onEdit={setEditing} onRestore={restoreRelease} onDelete={removeRelease} />}
            </div>
          ) : (
            <>
              <div className="rel" style={{ background: 'var(--bg-1)' }}>
                <div className="rel-head">
                  <span className="badge accent" style={{ fontSize: 13 }}>
                    <Tag size={12} style={{ marginRight: 4 }} /> {rel.releases.length ? `v${v.version}` : `v${v.version} — not released yet`}
                  </span>
                  <span className="muted small">
                    {rel.pending.commits > 0
                      ? `${rel.pending.commits} change${rel.pending.commits === 1 ? '' : 's'} since ${rel.releases.length ? 'this release' : 'the project started'}`
                      : rel.releases.length
                        ? 'Nothing changed since this release'
                        : 'Make the first release when it is ready'}
                  </span>
                  <span className="spacer" />
                  <button className="btn sm ghost" disabled={busy} onClick={() => void setVersioning(false)} title="Stop numbering versions (releases stay)">
                    Switch off
                  </button>
                </div>
              </div>
              {rel.releases.length === 0 ? (
                <Empty icon={Tag} title="No releases yet">
                  A release gives the current state a version number, notes and downloads. Use “New release” — or ask the AI to “release version {rel.next.patch}”.
                </Empty>
              ) : (
                <ReleaseList rel={rel} project={project} busy={busy} onEdit={setEditing} onRestore={restoreRelease} onDelete={removeRelease} />
              )}
            </>
          ))}

        {view === 'changes' &&
          (!commits ? (
            <div className="center" style={{ padding: 30 }}>
              <Spinner />
            </div>
          ) : !commits.length ? (
            <Empty icon={History} title="No history yet" />
          ) : (
            <>
              <div className="faint small" style={{ padding: '10px 18px 0' }}>
                The state of the project is saved automatically after every AI turn. Any of these can be restored.
              </div>
              {commits.map((c, i) => (
                <div key={c.sha}>
                  <div className="commit">
                    <GitCommitHorizontal size={16} style={{ marginTop: 2, flex: 'none' }} color={i === 0 ? 'var(--accent)' : 'var(--text-faint)'} />
                    <div className="grow" style={{ cursor: 'pointer' }} onClick={() => toggle(c.sha)}>
                      <div style={{ fontWeight: 550 }}>
                        {c.message}
                        {releaseTags.has(c.sha) && (
                          <span className="badge accent" style={{ marginLeft: 8 }}>
                            v{releaseTags.get(c.sha)}
                          </span>
                        )}
                      </div>
                      <div className="faint small">
                        {timeAgo(c.date)} · {c.author} · {c.files} file{c.files === 1 ? '' : 's'} · <span className="sha">{c.short}</span>
                        {i === 0 && <span className="badge accent" style={{ marginLeft: 8 }}>current</span>}
                      </div>
                      {open === c.sha && <pre className="small muted" style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>{stat[c.sha] ?? 'loading…'}</pre>}
                    </div>
                    {i > 0 && (
                      <button className="btn sm" onClick={() => restore(c)} disabled={busy || project.busy}>
                        <RotateCcw size={14} /> Restore
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </>
          ))}
      </div>

      {releasing && rel && (
        <ReleaseModal
          project={project}
          rel={rel}
          onClose={() => setReleasing(false)}
          onDone={(r) => {
            applyRel(r);
            setReleasing(false);
            void load();
          }}
        />
      )}
      {editing && (
        <NotesModal
          project={project}
          release={editing}
          onClose={() => setEditing(null)}
          onSaved={(r) => {
            setRel((cur) => (cur ? { ...cur, releases: cur.releases.map((x) => (x.id === r.id ? r : x)) } : cur));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ReleaseList({
  rel,
  project,
  busy,
  onEdit,
  onRestore,
  onDelete,
}: {
  rel: ReleasesData;
  project: Project;
  busy: boolean;
  onEdit: (r: Release) => void;
  onRestore: (r: Release) => void;
  onDelete: (r: Release) => void;
}) {
  return (
    <div>
      {rel.releases.map((r, i) => (
        <div key={r.id} className="rel">
          <div className="rel-head">
            <b className="mono" style={{ fontSize: 15 }}>
              v{r.version}
            </b>
            {r.title && <b>{r.title}</b>}
            {i === 0 && <span className="badge ok">latest</span>}
            <span className="faint small" title={new Date(r.createdAt).toLocaleString()}>
              {timeAgo(r.createdAt)}
              {r.createdBy ? ` · ${r.createdBy}` : ''}
            </span>
            <span className="spacer" />
            {r.sha && (
              <a className="btn sm" href={`/api/projects/${project.id}/releases/${r.id}/source.zip`} title="The project files as they were at this version (zip)">
                <Download size={14} /> Files
              </a>
            )}
            {r.exports && (
              <a
                className="btn sm"
                href={`/api/projects/${project.id}/releases/${r.id}/exports.zip`}
                title={`The finished files in exports/ at this version — ${r.exports.files} file${r.exports.files === 1 ? '' : 's'}, ${formatBytes(r.exports.bytes)}`}
              >
                <Package size={14} /> Exports
              </a>
            )}
            <button className="btn sm ghost icon" title="Edit title and notes" onClick={() => onEdit(r)}>
              <Pencil size={14} />
            </button>
            {r.sha && i > 0 && (
              <button className="btn sm ghost icon" title="Restore the files of this version" disabled={busy || project.busy} onClick={() => onRestore(r)}>
                <RotateCcw size={14} />
              </button>
            )}
            <button className="btn sm ghost icon" title="Delete this release" disabled={busy} onClick={() => onDelete(r)}>
              <Trash2 size={14} />
            </button>
          </div>
          {r.notes && <div className="rel-notes">{r.notes}</div>}
        </div>
      ))}
    </div>
  );
}

function ReleaseModal({ project, rel, onClose, onDone }: { project: Project; rel: ReleasesData; onClose: () => void; onDone: (r: ReleasesData) => void }) {
  const ui = useUi();
  const first = rel.releases.length === 0;
  const [bump, setBump] = useState<Bump>(first ? 'patch' : 'minor');
  const [custom, setCustom] = useState('');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [keepExports, setKeepExports] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const options: { id: Bump; label: string; hint: string; version: string }[] = first
    ? [
        { id: 'patch', label: 'First release', hint: 'the start version', version: rel.next.patch },
        ...(rel.next.major !== rel.next.patch ? [{ id: 'major' as Bump, label: 'Stable', hint: 'ready for others', version: rel.next.major }] : []),
      ]
    : [
        { id: 'patch', label: 'Patch', hint: 'fixes', version: rel.next.patch },
        { id: 'minor', label: 'Minor', hint: 'new features', version: rel.next.minor },
        { id: 'major', label: 'Major', hint: 'big or breaking changes', version: rel.next.major },
      ];
  const target = bump === 'custom' ? custom.trim() : (options.find((o) => o.id === bump)?.version ?? '');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<ReleasesData & { exportsNote: string | null }>(`/projects/${project.id}/releases`, {
        body: { ...(bump === 'custom' ? { version: custom.trim() } : { bump }), title: title.trim() || undefined, notes, exports: keepExports },
      });
      ui.toast(`Version ${r.versioning.version} released`);
      if (r.exportsNote) ui.toast(r.exportsNote, 'info');
      onDone(r);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New release"
      icon={<Tag size={18} />}
      size="medium"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy || !target}>
            {busy ? <Spinner size={14} /> : <Tag size={15} />} Release {target ? `v${target.replace(/^v/i, '')}` : ''}
          </button>
        </>
      }
    >
      {error && <div className="form-error" style={{ marginBottom: 14 }}>{error}</div>}
      <div className="field" style={{ marginTop: 0 }}>
        <label className="label">Version</label>
        <div className="bump">
          {options.map((o) => (
            <button key={o.id} type="button" className={cls(bump === o.id && 'active')} onClick={() => setBump(o.id)}>
              <b>{o.version}</b>
              <span>
                {o.label} — {o.hint}
              </span>
            </button>
          ))}
          <button type="button" className={cls(bump === 'custom' && 'active')} onClick={() => setBump('custom')}>
            <b>
              <input
                className="input mono"
                style={{ height: 26, padding: '0 6px', fontSize: 14 }}
                placeholder="x.y.z"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onFocus={() => setBump('custom')}
                aria-label="Own version number"
              />
            </b>
            <span>Your own number</span>
          </button>
        </div>
      </div>
      <div className="field">
        <label className="label">Title (optional)</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Multiplayer" maxLength={200} />
      </div>
      <div className="field">
        <label className="label">What is new?</label>
        <textarea className="textarea" rows={6} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={'- Added …\n- Fixed …'} />
        {rel.pending.messages.length > 0 && (
          <div className="hint">
            {rel.pending.commits} change{rel.pending.commits === 1 ? '' : 's'} since the last release.{' '}
            <a
              href="#fill"
              onClick={(e) => {
                e.preventDefault();
                setNotes((n) => [n.trim(), ...rel.pending.messages.map((m) => `- ${m.replace(/^(Claude|[\w .-]{1,24}): /, '')}`)].filter(Boolean).join('\n'));
              }}
            >
              Insert them as a list
            </a>{' '}
            and tidy it up. Notes under “Unreleased” in CHANGELOG.md are added by themselves.
          </div>
        )}
      </div>
      <label className="row" style={{ gap: 8, marginTop: 14 }}>
        <input type="checkbox" checked={keepExports} onChange={(e) => setKeepExports(e.target.checked)} />
        <span>
          Keep a copy of <code className="code-inline">exports/</code> with this release
          <span className="faint small"> — the finished files, downloadable later (up to {rel.exportsLimitMb} MB)</span>
        </span>
      </label>
      <div className="hint">Build the finished files first (ask the AI) — a release stores what is there now. It writes VERSION and CHANGELOG.md and tags the state in the history.</div>
    </Modal>
  );
}

function NotesModal({ project, release, onClose, onSaved }: { project: Project; release: Release; onClose: () => void; onSaved: (r: Release) => void }) {
  const ui = useUi();
  const [title, setTitle] = useState(release.title);
  const [notes, setNotes] = useState(release.notes);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ release: Release }>(`/projects/${project.id}/releases/${release.id}`, { method: 'PATCH', body: { title, notes } });
      onSaved(r.release);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Release ${release.version}`}
      icon={<Tag size={18} />}
      size="medium"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy && <Spinner size={14} />} Save
          </button>
        </>
      }
    >
      <div className="field" style={{ marginTop: 0 }}>
        <label className="label">Title</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </div>
      <div className="field">
        <label className="label">Notes</label>
        <textarea className="textarea" rows={8} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="hint">Shown here. CHANGELOG.md in the project is a file of its own — edit it there if it should change too.</div>
      </div>
    </Modal>
  );
}
