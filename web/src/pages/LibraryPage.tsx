import { Globe, Library, Search, Upload } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, assetFileUrl, assetThumbUrl, errMsg, upload, type Asset } from '../api';
import { AssetDetail } from '../components/AssetDetail';
import { Empty, KindIcon, Modal, Spinner, useDebounced, useUi } from '../components/ui';
import { ASSET_KINDS, formatBytes, guessKind, prettyName, viewKind } from '../util';

function Thumb({ a }: { a: Asset }) {
  if (a.hasThumb) return <img src={assetThumbUrl(a.id, a.updatedAt)} alt="" loading="lazy" className={a.kind === 'audio' ? 'contain' : ''} />;
  if (a.mainFile && viewKind(a.mainFile) === 'image') return <img src={assetFileUrl(a.id, a.mainFile)} alt="" loading="lazy" className="contain" />;
  return <KindIcon kind={a.kind} size={40} />;
}

export function LibraryPage({ scope }: { scope: 'mine' | 'global' }) {
  const ui = useUi();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<Asset[] | null>(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [uploading, setUploading] = useState(false);
  const dq = useDebounced(q, 250);
  const openId = params.get('asset');

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ scope, q: dq, kind, limit: '120' });
      const r = await api<{ items: Asset[]; total: number }>(`/library?${qs}`);
      setItems(r.items);
      setTotal(r.total);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
      setItems([]);
    }
  }, [scope, dq, kind, ui]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  const open = (id: string | null) => {
    const p = new URLSearchParams(params);
    if (id) p.set('asset', id);
    else p.delete('asset');
    setParams(p, { replace: true });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
          {scope === 'mine' ? <Library size={30} color="var(--accent)" /> : <Globe size={30} color="var(--accent-2)" />}
          <div>
            <h1>{scope === 'mine' ? 'My library' : 'Global Space'}</h1>
            <p>
              {scope === 'mine'
                ? 'Assets you or Claude saved for reuse. Publish the good ones to the Global Space so everybody — and every Claude — can use them.'
                : 'Assets shared by everyone on this Studio. Import them into your projects, or let Claude find them while it works.'}
            </p>
          </div>
        </div>
        {scope === 'mine' && (
          <button className="btn primary" onClick={() => setUploading(true)}>
            <Upload size={15} /> Upload asset
          </button>
        )}
      </div>

      <div className="row wrap" style={{ marginBottom: 18 }}>
        <div className="row" style={{ position: 'relative', width: 320 }}>
          <Search size={15} style={{ position: 'absolute', left: 10, color: 'var(--text-faint)' }} />
          <input className="input" style={{ paddingLeft: 32 }} placeholder="Search name, description, tags" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className={`chip ${!kind ? 'active' : ''}`} onClick={() => setKind('')}>
          All
        </button>
        {ASSET_KINDS.map((k) => (
          <button key={k.id} className={`chip ${kind === k.id ? 'active' : ''}`} onClick={() => setKind(k.id)}>
            <KindIcon kind={k.id} size={14} /> {k.label}
          </button>
        ))}
        <span className="spacer" />
        {items && <span className="faint small">{total} asset{total === 1 ? '' : 's'}</span>}
      </div>

      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="card">
          <Empty icon={scope === 'mine' ? Library : Globe} title={dq || kind ? 'Nothing found' : scope === 'mine' ? 'Your library is empty' : 'Nothing shared yet'}>
            {scope === 'mine'
              ? 'Add files from a project (right-click → Add to library), upload files, or ask Claude to save what it made.'
              : 'Publish an asset from your library to share it here.'}
          </Empty>
        </div>
      ) : (
        <div className="asset-grid">
          {items.map((a) => (
            <button key={a.id} className="asset-card" onClick={() => open(a.id)}>
              <div className="asset-thumb">
                <Thumb a={a} />
              </div>
              <div className="asset-info">
                <div className="name">{a.name}</div>
                <div className="row small faint" style={{ gap: 6 }}>
                  <KindIcon kind={a.kind} size={13} />
                  <span>{ASSET_KINDS.find((k) => k.id === a.kind)?.label ?? a.kind}</span>
                  <span>·</span>
                  <span>{formatBytes(a.sizeBytes)}</span>
                  <span className="spacer" />
                  {scope === 'mine' && a.visibility === 'global' && <Globe size={13} color="var(--accent-2)" />}
                </div>
                {scope === 'global' && <div className="small muted">by {a.owner.name ?? a.owner.username}</div>}
                {a.tags.length > 0 && (
                  <div className="tags">
                    {a.tags.slice(0, 4).map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {openId && (
        <AssetDetail
          assetId={openId}
          onClose={() => open(null)}
          onChanged={(a) => {
            if (!a) setItems((list) => list?.filter((x) => x.id !== openId) ?? null);
            else setItems((list) => list?.map((x) => (x.id === a.id ? a : x)) ?? null);
          }}
        />
      )}
      {uploading && (
        <UploadAssetModal
          onClose={() => setUploading(false)}
          onDone={(a) => {
            setUploading(false);
            void load();
            open(a.id);
          }}
        />
      )}
    </div>
  );
}

function UploadAssetModal({ onClose, onDone }: { onClose: () => void; onDone: (a: Asset) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('other');
  const [tags, setTags] = useState('');
  const [description, setDescription] = useState('');
  const [license, setLicense] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');

  const pick = (list: File[]) => {
    setFiles(list);
    if (list[0]) {
      if (!name) setName(prettyName(list[0].name));
      setKind(guessKind(list[0].name));
    }
  };

  const submit = async () => {
    setError('');
    const form = new FormData();
    form.append('name', name);
    form.append('kind', kind);
    form.append('tags', tags);
    form.append('description', description);
    form.append('license', license);
    for (const f of files) form.append('files', f, (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
    setProgress(0);
    try {
      const r = await upload<{ asset: Asset }>('/library/upload', form, setProgress);
      onDone(r.asset);
    } catch (err) {
      setError(errMsg(err));
      setProgress(null);
    }
  };

  return (
    <Modal
      title="Upload to your library"
      icon={<Upload size={18} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!files.length || !name.trim() || progress !== null} onClick={submit}>
            {progress !== null ? (
              <>
                <Spinner size={14} /> {progress}%
              </>
            ) : (
              'Upload'
            )}
          </button>
        </>
      }
    >
      {error && <div className="form-error" style={{ marginBottom: 14 }}>{error}</div>}
      <div className="field">
        <label className="label">Files</label>
        <input type="file" multiple className="input" style={{ height: 'auto', padding: 8 }} onChange={(e) => pick([...(e.target.files ?? [])])} />
        <div className="hint">A model with its textures, a sprite sheet, a sound pack… Several files become one asset.</div>
      </div>
      <div className="field">
        <label className="label">Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="row" style={{ gap: 12, marginTop: 14 }}>
        <div className="field grow" style={{ marginTop: 0 }}>
          <label className="label">Kind</label>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            {ASSET_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field grow" style={{ marginTop: 0 }}>
          <label className="label">License</label>
          <input className="input" value={license} onChange={(e) => setLicense(e.target.value)} placeholder="optional" />
        </div>
      </div>
      <div className="field">
        <label className="label">Tags</label>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma separated" />
      </div>
      <div className="field">
        <label className="label">Description</label>
        <textarea className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
    </Modal>
  );
}
