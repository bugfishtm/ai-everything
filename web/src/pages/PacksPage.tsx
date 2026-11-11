import { Blocks, Box, Code, Copy, Download, Globe, Lock, Music, Package, Play, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errMsg, packFileUrl, type PackItem, type PackSummary } from '../api';
import { ModelViewer } from '../components/lazy';
import { Markdown } from '../components/Markdown';
import { Empty, Modal, Spinner, useDebounced, useUi } from '../components/ui';
import { useStudio } from '../store';
import { formatBytes, timeAgo, viewKind } from '../util';
import { socket } from '../ws';

const TYPES = [
  { id: '', label: 'All' },
  { id: 'music', label: 'Music' },
  { id: '3d', label: '3D' },
  { id: 'image', label: 'Image' },
  { id: 'video', label: 'Video' },
  { id: 'general', label: 'General' },
];
const SCOPES = [
  { id: '', label: 'All' },
  { id: 'system', label: 'Built-in' },
  { id: 'global', label: 'Global Space' },
  { id: 'user', label: 'Mine' },
];

export function TypeIcon({ type, size = 18 }: { type: string; size?: number }) {
  if (type === 'music') return <Music size={size} color="#f472b6" />;
  if (type === '3d') return <Box size={size} color="#60a5fa" />;
  return <Blocks size={size} color="#a78bfa" />;
}

function scopeBadge(p: PackSummary) {
  if (p.scope === 'system') return <span className="badge">built-in</span>;
  if (p.scope === 'global')
    return (
      <span className="badge accent">
        <Globe size={11} /> Global
      </span>
    );
  return (
    <span className="badge">
      <Lock size={11} /> mine
    </span>
  );
}

export function PacksPage() {
  const [params, setParams] = useSearchParams();
  const [packs, setPacks] = useState<PackSummary[] | null>(null);
  const [type, setType] = useState('');
  const [scope, setScope] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const open = params.get('pack');

  const load = useCallback(() => {
    api<{ packs: PackSummary[] }>('/packs')
      .then((r) => setPacks(r.packs))
      .catch(() => setPacks([]));
  }, []);
  useEffect(() => {
    load();
    return socket.on((m) => {
      if (m.t === 'packs.changed') load();
    });
  }, [load]);

  const list = useMemo(
    () =>
      (packs ?? []).filter(
        (p) =>
          (!type || p.type === type) &&
          (!scope || p.scope === scope) &&
          (!dq || `${p.id} ${p.name} ${p.description} ${p.tags.join(' ')}`.toLowerCase().includes(dq.toLowerCase())),
      ),
    [packs, type, scope, dq],
  );
  const setOpen = (key: string | null) => {
    const p = new URLSearchParams(params);
    if (key) p.set('pack', key);
    else p.delete('pack');
    setParams(p, { replace: true });
  };
  const current = packs?.find((p) => `${p.scope}:${p.id}` === open || p.id === open);

  return (
    <div className="page">
      <div className="page-head">
        <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
          <Package size={30} color="var(--accent)" />
          <div>
            <h1>Packs</h1>
            <p>
              Expansion content for the Studio software — instruments, samples, drum kits, presets, 3D models, materials and plugins. Claude reads every pack and
              uses its items (<code className="code-inline">pack/item</code>) in songs and scenes.
            </p>
          </div>
        </div>
      </div>
      <div className="row wrap" style={{ marginBottom: 18 }}>
        <div className="row" style={{ position: 'relative', width: 280 }}>
          <Search size={15} style={{ position: 'absolute', left: 10, color: 'var(--text-faint)' }} />
          <input className="input" style={{ paddingLeft: 32 }} placeholder="Search packs" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {TYPES.map((t) => (
          <button key={t.id} className={`chip ${type === t.id ? 'active' : ''}`} onClick={() => setType(t.id)}>
            {t.label}
          </button>
        ))}
        <span className="faint" style={{ margin: '0 4px' }}>
          ·
        </span>
        {SCOPES.map((s) => (
          <button key={s.id} className={`chip ${scope === s.id ? 'active' : ''}`} onClick={() => setScope(s.id)}>
            {s.label}
          </button>
        ))}
      </div>

      {!packs ? (
        <Spinner />
      ) : list.length === 0 ? (
        <div className="card">
          <Empty icon={Package} title="No packs here yet">
            Ask Claude in a project: “make a pack of these samples”, or create one yourself (folder with pack.json) and right-click it → Install as pack.
          </Empty>
        </div>
      ) : (
        <div className="project-grid">
          {list.map((p) => (
            <button key={`${p.scope}:${p.id}`} className="project-card" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setOpen(`${p.scope}:${p.id}`)}>
              <div className="row">
                <TypeIcon type={p.type} />
                <b className="grow ellipsis">{p.name}</b>
                {scopeBadge(p)}
              </div>
              <p>{p.description || <span className="faint">{p.id}</span>}</p>
              <div className="faint small">
                {Object.entries(p.kinds)
                  .map(([k, n]) => `${n} ${k}`)
                  .join(' · ')}{' '}
                · {formatBytes(p.sizeBytes)}
                {p.hasCode && !p.trusted && <span style={{ color: 'var(--warn)' }}> · code not reviewed</span>}
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="card pad" style={{ marginTop: 28 }}>
        <h3>Make your own pack</h3>
        <ol className="muted small" style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.8 }}>
          <li>
            In a project, ask Claude (“turn the samples in assets/ into a pack”) or run <code className="code-inline">studio packs new my-pack --type music</code> in the Shell.
          </li>
          <li>Put the files into packs/my-pack/ and list them as items in pack.json (format: packs/README.md in the repository).</li>
          <li>Right-click the folder in the file tree → Install as pack. It becomes your personal pack; publish it here to share it with everybody.</li>
        </ol>
      </div>

      {open && current && <PackDetail pack={current} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

function PackDetail({ pack, onClose, onChanged }: { pack: PackSummary; onClose: () => void; onChanged: () => void }) {
  const ui = useUi();
  const { user } = useStudio();
  const [items, setItems] = useState<PackItem[] | null>(null);
  const [docs, setDocs] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [playing, setPlaying] = useState<string | null>(null);
  const [model, setModel] = useState<PackItem | null>(null);

  useEffect(() => {
    api<{ items: PackItem[]; docs: string | null }>(`/packs/${pack.scope}/${pack.id}`)
      .then((r) => {
        setItems(r.items);
        setDocs(r.docs);
      })
      .catch((err) => ui.toast(errMsg(err), 'error'));
  }, [pack.scope, pack.id, ui]);

  const mine = pack.owner?.id === user?.id;
  const admin = user?.role === 'admin';
  const shown = (items ?? []).filter((it) => !filter || `${it.id} ${it.name ?? ''} ${it.kind} ${(it.tags ?? []).join(' ')}`.toLowerCase().includes(filter.toLowerCase()));

  const act = async (fn: () => Promise<unknown>, done: string, close = false) => {
    try {
      await fn();
      ui.toast(done);
      onChanged();
      if (close) onClose();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  const publish = async () => {
    const ok = await ui.confirm({
      title: `Publish “${pack.name}” to the Global Space?`,
      body: pack.hasCode
        ? 'Everybody can then use the pack. It contains code (plugins): that code only runs for others after an admin reviewed it.'
        : 'Everybody on this Studio — and every Claude session — can then use the pack.',
      confirm: 'Publish',
    });
    if (ok) await act(() => api(`/packs/user/${pack.id}/publish`, { body: {} }), 'Published to the Global Space', true);
  };

  return (
    <Modal title={pack.name} size="wide" icon={<TypeIcon type={pack.type} />} onClose={onClose}>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        {scopeBadge(pack)}
        <span className="badge">{pack.type}</span>
        {pack.version && <span className="badge">v{pack.version}</span>}
        {pack.license && <span className="badge">{pack.license}</span>}
        {pack.hasCode && (
          <span className={`badge ${pack.trusted ? 'ok' : 'warn'}`}>
            <Code size={11} /> {pack.trusted ? `code ${pack.reviewedBy ? `reviewed by ${pack.reviewedBy}` : 'trusted'}` : 'code not reviewed'}
          </span>
        )}
        <span className="faint small">
          {pack.itemCount} items · {formatBytes(pack.sizeBytes)}
          {pack.owner?.name ? ` · by ${pack.owner.name}` : pack.author ? ` · ${pack.author}` : ''}
          {pack.publishedAt ? ` · published ${timeAgo(pack.publishedAt)}` : pack.installedAt ? ` · installed ${timeAgo(pack.installedAt)}` : ''}
        </span>
      </div>
      {pack.description && <p className="muted" style={{ marginBottom: 12 }}>{pack.description}</p>}
      <div className="row wrap" style={{ marginBottom: 16 }}>
        <a className="btn" href={`/api/packs/${pack.scope}/${pack.id}/download`}>
          <Download size={14} /> Download zip
        </a>
        {pack.scope === 'user' && (
          <button className="btn" onClick={publish}>
            <Globe size={14} /> Publish to Global Space
          </button>
        )}
        {pack.scope === 'global' && (mine || admin) && (
          <button className="btn" onClick={() => act(() => api(`/packs/global/${pack.id}/unpublish`, { body: {} }), 'Moved back to the owner’s packs', true)}>
            <Lock size={14} /> Unpublish
          </button>
        )}
        {pack.scope === 'global' && admin && pack.hasCode && (
          <button className="btn" onClick={() => act(() => api(`/packs/global/${pack.id}/trust`, { body: { trusted: !pack.trusted } }), pack.trusted ? 'Code review revoked' : 'Code marked as reviewed', true)}>
            <ShieldCheck size={14} /> {pack.trusted ? 'Revoke code review' : 'Mark code as reviewed'}
          </button>
        )}
        {((pack.scope === 'user' && mine) || (pack.scope === 'global' && (mine || admin))) && (
          <button
            className="btn ghost danger"
            onClick={async () => {
              const ok = await ui.confirm({ title: `Delete pack “${pack.name}”?`, body: 'Songs and scenes that use it will not find its items any more.', confirm: 'Delete', danger: true });
              if (ok) await act(() => api(`/packs/${pack.scope}/${pack.id}`, { method: 'DELETE' }), 'Pack deleted', true);
            }}
          >
            <Trash2 size={14} /> Delete
          </button>
        )}
      </div>

      <div className="row" style={{ marginBottom: 8 }}>
        <b className="grow">Items</b>
        <input className="input" style={{ maxWidth: 260, height: 30 }} placeholder="Filter items" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {!items ? (
        <Spinner />
      ) : (
        <div style={{ maxHeight: 380, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Kind</th>
                <th>Name</th>
                <th>Details</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 500).map((it) => {
                const ref = `${pack.id}/${it.id}`;
                const kind = it.file ? viewKind(it.file) : 'binary';
                const meta = it.meta ?? {};
                const details = [
                  meta.program !== undefined ? `program ${String(meta.program)}` : '',
                  meta.family ? String(meta.family) : '',
                  it.media?.duration ? `${it.media.duration}s` : '',
                  it.media?.width ? `${it.media.width}×${it.media.height}` : '',
                  (it.tags ?? []).map((t) => `#${t}`).join(' '),
                ]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <tr key={it.id}>
                    <td>
                      <span className="row" style={{ gap: 4 }}>
                        <code className="code-inline">{ref}</code>
                        <button
                          className="btn ghost sm icon"
                          title="Copy reference"
                          onClick={() => {
                            void navigator.clipboard?.writeText(ref);
                            ui.toast(`Copied ${ref}`);
                          }}
                        >
                          <Copy size={12} />
                        </button>
                      </span>
                    </td>
                    <td className="faint small">{it.kind}</td>
                    <td>{it.name ?? ''}</td>
                    <td className="faint small">{details}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {it.file && kind === 'audio' && (
                        <button className="btn sm ghost" onClick={() => setPlaying(playing === it.id ? null : it.id)}>
                          <Play size={13} /> {playing === it.id ? 'Hide' : 'Play'}
                        </button>
                      )}
                      {it.file && kind === 'model' && (
                        <button className="btn sm ghost" onClick={() => setModel(it)}>
                          <Box size={13} /> View
                        </button>
                      )}
                      {playing === it.id && it.file && <audio autoPlay controls src={packFileUrl(pack.scope, pack.id, it.file)} style={{ height: 30, verticalAlign: 'middle' }} />}
                      {it.file && kind === 'image' && <img src={packFileUrl(pack.scope, pack.id, it.file)} alt="" style={{ height: 36, borderRadius: 4, verticalAlign: 'middle' }} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {docs && (
        <div className="card pad" style={{ marginTop: 16 }}>
          <Markdown text={docs} />
        </div>
      )}
      {model?.file && (
        <Modal title={`${pack.id}/${model.id}`} size="wide" onClose={() => setModel(null)}>
          <div className="asset-stage" style={{ height: 480 }}>
            <ModelViewer url={packFileUrl(pack.scope, pack.id, model.file)} fileName={model.file} />
          </div>
        </Modal>
      )}
    </Modal>
  );
}
