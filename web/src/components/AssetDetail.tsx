import { Camera, Copy, Download, FolderInput, Globe, Lock, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, assetFileUrl, assetThumbUrl, errMsg, type Asset, type Project } from '../api';
import { useStudio } from '../store';
import { ASSET_KINDS, formatBytes, timeAgo, viewKind } from '../util';
import { ModelViewer } from './lazy';
import type { ModelViewerHandle } from './ModelViewer';
import { Empty, KindIcon, Modal, Spinner, useUi } from './ui';

async function putThumb(id: string, blob: Blob): Promise<void> {
  const res = await fetch(`/api/library/${id}/thumb`, {
    method: 'PUT',
    headers: { 'x-studio': '1', 'content-type': blob.type || 'image/png' },
    body: blob,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'upload failed');
}

export function AssetDetail({ assetId, onClose, onChanged }: { assetId: string; onClose: () => void; onChanged: (a: Asset | null) => void }) {
  const ui = useUi();
  const { user } = useStudio();
  const [asset, setAsset] = useState<Asset | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [target, setTarget] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const [thumbV, setThumbV] = useState(Date.now());
  const [text, setText] = useState<string | null>(null);
  const viewer = useRef<ModelViewerHandle>(null);
  const video = useRef<HTMLVideoElement>(null);
  // edit form
  const [form, setForm] = useState({ name: '', kind: '', tags: '', description: '', license: '', main: '' });

  useEffect(() => {
    api<{ asset: Asset }>(`/library/${assetId}`)
      .then((r) => {
        setAsset(r.asset);
        setForm({
          name: r.asset.name,
          kind: r.asset.kind,
          tags: r.asset.tags.join(', '),
          description: r.asset.description,
          license: r.asset.license ?? '',
          main: r.asset.mainFile ?? '',
        });
      })
      .catch((err) => setError(errMsg(err)));
  }, [assetId]);

  const main = asset?.mainFile ?? null;
  const kind = main ? viewKind(main) : 'binary';
  const mainUrl = asset && main ? assetFileUrl(asset.id, main) : '';
  const owner = !!asset && !!user && asset.owner.id === user.id;
  const canManage = owner || user?.role === 'admin';

  useEffect(() => {
    setText(null);
    if (!asset || !main || kind !== 'text') return;
    const size = asset.files.find((f) => f.path === main)?.size ?? 0;
    if (size > 300_000) return;
    fetch(mainUrl)
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then(setText)
      .catch(() => setText(null));
  }, [asset, main, kind, mainUrl]);

  const loadProjects = async () => {
    if (projects) return;
    const r = await api<{ projects: Project[] }>('/projects');
    setProjects(r.projects);
    if (r.projects[0]) setTarget(r.projects[0].id);
  };

  const update = (a: Asset) => {
    setAsset(a);
    onChanged(a);
  };

  const importTo = async () => {
    if (!asset || !target) return;
    setBusy(true);
    try {
      const r = await api<{ dest: string }>(`/library/${asset.id}/import`, { body: { projectId: target } });
      ui.toast(`Imported into ${r.dest}/`);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const publish = async (on: boolean) => {
    if (!asset) return;
    if (on) {
      const ok = await ui.confirm({
        title: 'Publish to the Global Space?',
        body: 'Every user of this Studio — and their Claude sessions — will be able to find, view, download and reuse this asset. You can unpublish it later.',
        confirm: 'Publish',
      });
      if (!ok) return;
    }
    try {
      const r = await api<{ asset: Asset }>(`/library/${asset.id}/${on ? 'publish' : 'unpublish'}`, { body: {} });
      update(r.asset);
      ui.toast(on ? 'Published to the Global Space' : 'Asset is private again');
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  const remove = async () => {
    if (!asset) return;
    const ok = await ui.confirm({ title: `Delete “${asset.name}”?`, body: 'The asset is removed from the library (copies already imported into projects stay).', confirm: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api(`/library/${asset.id}`, { method: 'DELETE' });
      onChanged(null);
      onClose();
      ui.toast('Asset deleted');
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  const saveEdit = async () => {
    if (!asset) return;
    try {
      const r = await api<{ asset: Asset }>(`/library/${asset.id}`, {
        method: 'PATCH',
        body: { name: form.name, kind: form.kind, tags: form.tags, description: form.description, license: form.license, main: form.main },
      });
      update(r.asset);
      setEditing(false);
      ui.toast('Saved');
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  const captureThumb = async () => {
    if (!asset) return;
    let blob: Blob | null = null;
    if (kind === 'model') blob = (await viewer.current?.capture()) ?? null;
    else if (kind === 'video' && video.current) {
      const v = video.current;
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d')?.drawImage(v, 0, 0);
      blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    }
    if (!blob) return ui.toast('Could not capture the view', 'error');
    try {
      await putThumb(asset.id, blob);
      setThumbV(Date.now());
      update({ ...asset, hasThumb: true });
      ui.toast('Thumbnail updated');
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  if (error) {
    return (
      <Modal title="Asset" onClose={onClose}>
        <Empty title="Cannot open asset">{error}</Empty>
      </Modal>
    );
  }
  if (!asset) {
    return (
      <Modal title="Asset" onClose={onClose}>
        <div className="center" style={{ padding: 40 }}>
          <Spinner />
        </div>
      </Modal>
    );
  }

  let stage: React.ReactNode;
  if (!main) stage = <Empty title="No files" />;
  else if (kind === 'model') stage = <ModelViewer ref={viewer} url={mainUrl} fileName={main} />;
  else if (kind === 'image')
    stage = (
      <div className="viewer-media">
        <img src={mainUrl} alt={asset.name} />
      </div>
    );
  else if (kind === 'video')
    stage = (
      <div className="viewer-media">
        <video ref={video} controls src={mainUrl} />
      </div>
    );
  else if (kind === 'audio')
    stage = (
      <div className="audio-box">
        {asset.hasThumb ? <img src={assetThumbUrl(asset.id, thumbV)} alt="" style={{ maxWidth: '100%', borderRadius: 8 }} /> : <KindIcon kind={asset.kind} size={48} />}
        <audio controls src={mainUrl} />
      </div>
    );
  else if (text !== null)
    stage = (
      <pre className="mono small" style={{ margin: 0, padding: 16, position: 'absolute', inset: 0, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
        {text}
      </pre>
    );
  else
    stage = (
      <Empty title={main}>
        <a className="btn" href={`${mainUrl}?download=1`}>
          <Download size={14} /> Download file
        </a>
      </Empty>
    );

  return (
    <Modal title={asset.name} size="wide" icon={<KindIcon kind={asset.kind} />} onClose={onClose}>
      <div className="asset-detail">
        <div className="col" style={{ gap: 10 }}>
          <div className="asset-stage">{stage}</div>
          {owner && (kind === 'model' || kind === 'video') && (
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={captureThumb}>
              <Camera size={14} /> Use current view as thumbnail
            </button>
          )}
        </div>

        <div className="col" style={{ gap: 14 }}>
          {!editing ? (
            <>
              <div className="row wrap">
                <span className="badge">{ASSET_KINDS.find((k) => k.id === asset.kind)?.label ?? asset.kind}</span>
                {asset.visibility === 'global' ? (
                  <span className="badge accent">
                    <Globe size={12} /> Global Space
                  </span>
                ) : (
                  <span className="badge">
                    <Lock size={12} /> Private
                  </span>
                )}
                {asset.license && <span className="badge">{asset.license}</span>}
              </div>
              {asset.description ? <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{asset.description}</p> : <p className="faint">No description.</p>}
              {asset.tags.length > 0 && (
                <div className="tags">
                  {asset.tags.map((t) => (
                    <span key={t} className="tag">
                      #{t}
                    </span>
                  ))}
                </div>
              )}
              <dl className="kv">
                <dt>Asset id</dt>
                <dd className="row" style={{ gap: 6 }}>
                  <code className="code-inline">{asset.id}</code>
                  <button
                    className="btn ghost sm icon"
                    title="Copy id (tell Claude: use asset …)"
                    onClick={() => {
                      void navigator.clipboard?.writeText(asset.id);
                      ui.toast('Asset id copied');
                    }}
                  >
                    <Copy size={13} />
                  </button>
                </dd>
                <dt>Owner</dt>
                <dd>{asset.owner.name ?? asset.owner.username}</dd>
                <dt>Size</dt>
                <dd>
                  {formatBytes(asset.sizeBytes)} · {asset.files.length} file{asset.files.length === 1 ? '' : 's'}
                </dd>
                <dt>Created</dt>
                <dd>{timeAgo(asset.createdAt)}</dd>
                {asset.publishedAt && (
                  <>
                    <dt>Published</dt>
                    <dd>{timeAgo(asset.publishedAt)}</dd>
                  </>
                )}
                <dt>Imported</dt>
                <dd>{asset.importCount}×</dd>
              </dl>
            </>
          ) : (
            <div className="col" style={{ gap: 0 }}>
              <div className="field">
                <label className="label">Name</label>
                <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="field">
                <label className="label">Kind</label>
                <select className="select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  {ASSET_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="label">Main file</label>
                <select className="select" value={form.main} onChange={(e) => setForm({ ...form, main: e.target.value })}>
                  {asset.files.map((f) => (
                    <option key={f.path} value={f.path}>
                      {f.path}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="label">Tags</label>
                <input className="input" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
              </div>
              <div className="field">
                <label className="label">License</label>
                <input className="input" value={form.license} onChange={(e) => setForm({ ...form, license: e.target.value })} />
              </div>
              <div className="field">
                <label className="label">Description</label>
                <textarea className="textarea" rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </div>
              <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button className="btn primary" onClick={saveEdit}>
                  Save
                </button>
              </div>
            </div>
          )}

          <div className="card pad col" style={{ gap: 10, padding: 14 }}>
            <b className="small">Use in a project</b>
            <div className="row">
              <select className="select" value={target} onFocus={() => void loadProjects()} onClick={() => void loadProjects()} onChange={(e) => setTarget(Number(e.target.value) || '')}>
                {!projects && <option value="">Choose a project…</option>}
                {projects?.length === 0 && <option value="">No projects yet</option>}
                {projects?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button className="btn primary" disabled={!target || busy} onClick={importTo}>
                {busy ? <Spinner size={14} /> : <FolderInput size={15} />} Import
              </button>
            </div>
            <div className="hint" style={{ marginTop: 0 }}>
              Copies the files into <code>assets/library/</code>. Claude can do this itself: “use asset {asset.id}”.
            </div>
          </div>

          <div className="row wrap">
            <a className="btn" href={`/api/library/${asset.id}/download`}>
              <Download size={14} /> Download
            </a>
            {owner && asset.visibility === 'private' && (
              <button className="btn" onClick={() => publish(true)}>
                <Globe size={14} /> Publish to Global Space
              </button>
            )}
            {canManage && asset.visibility === 'global' && (
              <button className="btn" onClick={() => publish(false)}>
                <Lock size={14} /> Unpublish
              </button>
            )}
            {canManage && !editing && (
              <button className="btn ghost" onClick={() => setEditing(true)}>
                <Pencil size={14} /> Edit
              </button>
            )}
            {canManage && (
              <button className="btn ghost danger" onClick={remove}>
                <Trash2 size={14} /> Delete
              </button>
            )}
          </div>

          <div>
            <div className="label">Files</div>
            <div className="files-list">
              {asset.files.map((f) => (
                <div key={f.path}>
                  <a className="grow ellipsis mono" href={`${assetFileUrl(asset.id, f.path)}?download=1`} title="Download">
                    {f.path}
                  </a>
                  <span className="faint">{formatBytes(f.size)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
