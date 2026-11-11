import { Library, Plus, Settings, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errMsg, type Area, type Asset, type Project } from '../api';
import { useStudio } from '../store';
import { ASSET_KINDS, guessKind, MODEL_SUGGESTIONS, PERMISSION_MODES, prettyName } from '../util';
import { AreaIcon, Modal, Spinner, useUi } from './ui';

// ---------------------------------------------------------------------------
export function NewProjectModal({ area, initialDescription, onClose }: { area: Area; initialDescription?: string; onClose: () => void }) {
  const nav = useNavigate();
  const { refreshAreas } = useStudio();
  const [name, setName] = useState('');
  const [description, setDescription] = useState(initialDescription ?? '');
  const [versioning, setVersioning] = useState(!!area.versioning);
  const [version, setVersion] = useState('0.1.0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ project: Project }>('/projects', {
        body: {
          name: name.trim() || `New ${area.name.toLowerCase()} project`,
          area: area.id,
          description,
          versioning: versioning ? { enabled: true, version: version.trim() || '0.1.0' } : undefined,
        },
      });
      void refreshAreas();
      onClose();
      nav(`/p/${r.project.id}${initialDescription ? `?prompt=${encodeURIComponent(initialDescription)}` : ''}`);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`New ${area.name} project`}
      icon={
        <span className="area-icon" style={{ ['--area' as string]: area.color, width: 32, height: 32 }}>
          <AreaIcon icon={area.icon} size={17} />
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={create} disabled={busy}>
            {busy ? <Spinner size={14} /> : <Plus size={15} />} Create project
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        {error && <div className="form-error" style={{ marginBottom: 14 }}>{error}</div>}
        <div className="field">
          <label className="label">Name</label>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={`My ${area.name.toLowerCase()} project`} maxLength={128} />
        </div>
        <div className="field">
          <label className="label">What is it about? (optional)</label>
          <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="A short description — it goes into the project's CLAUDE.md." rows={4} />
          <div className="hint">You can describe everything in detail later in the chat.</div>
        </div>
        <div className="field">
          <label className="row" style={{ gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="checkbox" checked={versioning} onChange={(e) => setVersioning(e.target.checked)} style={{ marginTop: 3 }} />
            <span className="grow">
              <b>Versioning</b>
              <span className="muted small" style={{ display: 'block' }}>
                Number your work — 1.0.0, 1.1.0 … Each release keeps its notes, the files as they were and a copy of the finished exports, so you can download
                or go back to any version. (The step-by-step history is always kept; this adds the numbers.)
              </span>
            </span>
            {versioning && (
              <span className="col" style={{ gap: 3, flex: 'none' }}>
                <span className="faint small">starts at</span>
                <input className="input mono" style={{ width: 96 }} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="0.1.0" aria-label="Start version" />
              </span>
            )}
          </label>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
export function AddToLibraryModal({ project, paths, onClose }: { project: Project; paths: string[]; onClose: () => void }) {
  const ui = useUi();
  const nav = useNavigate();
  const [name, setName] = useState(prettyName(paths[0] ?? 'Asset'));
  const [kind, setKind] = useState(guessKind(paths[0] ?? ''));
  const [tags, setTags] = useState('');
  const [description, setDescription] = useState('');
  const [license, setLicense] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ asset: Asset }>('/library/from-project', {
        body: { projectId: project.id, paths, name, kind, tags, description, license: license || undefined },
      });
      onClose();
      ui.toast(
        <>
          Saved “{r.asset.name}” to your library.{' '}
          <a href="/library" onClick={(e) => { e.preventDefault(); nav(`/library?asset=${r.asset.id}`); }}>
            Open
          </a>
        </>,
      );
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add to your library"
      icon={<Library size={18} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !name.trim()}>
            {busy ? <Spinner size={14} /> : <Library size={15} />} Save to library
          </button>
        </>
      }
    >
      {error && <div className="form-error" style={{ marginBottom: 14 }}>{error}</div>}
      <div className="field">
        <label className="label">Files</label>
        <div className="mono small muted">{paths.join(', ')}</div>
        <div className="hint">Folders are added with everything inside (e.g. a model with its textures). Tip: include the text source next to the render.</div>
      </div>
      <div className="field">
        <label className="label">Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} autoFocus />
      </div>
      <div className="row" style={{ gap: 12, marginTop: 14, alignItems: 'flex-start' }}>
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
          <label className="label">License (optional)</label>
          <input className="input" value={license} onChange={(e) => setLicense(e.target.value)} placeholder="CC0, CC-BY-4.0, …" />
        </div>
      </div>
      <div className="field">
        <label className="label">Tags</label>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tree, nature, low-poly" />
        <div className="hint">Claude finds assets by name, description and tags.</div>
      </div>
      <div className="field">
        <label className="label">Description</label>
        <textarea className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is it, how was it made, how should it be used?" />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
export function ProjectSettingsModal({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved: (p: Project) => void }) {
  const ui = useUi();
  const nav = useNavigate();
  const { refreshAreas, agents } = useStudio();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [provider, setProvider] = useState(project.settings.provider ?? '');
  const [model, setModel] = useState(project.settings.model ?? '');
  const [effort, setEffort] = useState(project.settings.effort ?? '');
  const [permissionMode, setPermissionMode] = useState(project.settings.permissionMode);
  const [previewPath, setPreviewPath] = useState(project.settings.previewPath ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ project: Project }>(`/projects/${project.id}`, {
        method: 'PATCH',
        body: { name, description, settings: { provider, model, effort, permissionMode, previewPath } },
      });
      onSaved({ ...r.project, dir: project.dir });
      onClose();
      ui.toast('Project settings saved');
    } catch (err) {
      ui.toast(errMsg(err), 'error');
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await ui.confirm({
      title: `Delete “${project.name}”?`,
      body: 'The project is moved to the trash and deleted for good after a few days. Assets you saved to the library stay.',
      confirm: 'Delete project',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/projects/${project.id}`, { method: 'DELETE' });
      void refreshAreas();
      onClose();
      nav(`/area/${project.area}`);
      ui.toast('Project deleted');
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  return (
    <Modal
      title="Project settings"
      icon={<Settings size={18} />}
      size="medium"
      onClose={onClose}
      footer={
        <>
          <button className="btn danger" onClick={remove} style={{ marginRight: 'auto' }}>
            <Trash2 size={14} /> Delete project
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy && <Spinner size={14} />} Save
          </button>
        </>
      }
    >
      <div className="field">
        <label className="label">Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
      </div>
      <div className="field">
        <label className="label">Description</label>
        <textarea className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <hr />
      {(() => {
        const list = agents?.agents ?? [];
        const effective = provider || agents?.prefs.defaultProvider || 'claude';
        const agent = list.find((a) => a.id === effective);
        const fallbackName = (id: string) => (id === 'claude' ? 'Claude Code' : (list.find((a) => a.id === id)?.name ?? id));
        return (
          <>
            {list.length > 0 && (
              <div className="field">
                <label className="label">AI for new chats</label>
                <select
                  className="select"
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value);
                    setModel('');
                  }}
                >
                  <option value="">Your default ({fallbackName(agents?.prefs.defaultProvider || 'claude')})</option>
                  <option value="claude">Claude Code (Anthropic)</option>
                  {list.map((a) => (
                    <option key={a.id} value={a.id} disabled={a.install.state !== 'ready'}>
                      {a.name}
                      {a.vendor !== 'any provider' && a.vendor !== 'custom' ? ` (${a.vendor})` : ''}
                      {a.install.state !== 'ready' ? ' — being installed' : a.status && a.status.connected === false ? ' — not connected yet' : ''}
                    </option>
                  ))}
                </select>
                <div className="hint">Existing chats keep the AI they started with. Connect AIs on the Account page.</div>
              </div>
            )}
            <div className="row" style={{ gap: 12, marginTop: 14, alignItems: 'flex-start' }}>
              <div className="field grow" style={{ marginTop: 0 }}>
                <label className="label">Model</label>
                <input className="input" list="model-list" value={model} onChange={(e) => setModel(e.target.value)} placeholder="account default" />
                <datalist id="model-list">
                  {(agent ? (agent.models ?? []).map((m) => m.value) : MODEL_SUGGESTIONS).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <div className="hint">
                  {agent
                    ? `A model of ${agent.name}${agent.id === 'opencode' ? ' as provider/model (e.g. openrouter/…)' : ''} — empty = your default for it.`
                    : 'An alias (fable, opus, sonnet, haiku) or a full model name.'}
                </div>
              </div>
              {!agent && (
                <div className="field grow" style={{ marginTop: 0 }}>
                  <label className="label">Effort</label>
                  <select className="select" value={effort} onChange={(e) => setEffort(e.target.value)}>
                    <option value="">default</option>
                    {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </>
        );
      })()}
      <div className="field" style={{ marginTop: 16 }}>
        <label className="label">How much may the AI do on its own?</label>
        <div className="col" style={{ gap: 6 }}>
          {PERMISSION_MODES.map((m) => (
            <label key={m.id} className="row" style={{ alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
              <input type="radio" name="perm" checked={permissionMode === m.id} onChange={() => setPermissionMode(m.id)} style={{ marginTop: 4 }} />
              <span>
                <b>{m.label}</b>
                <span className="muted small" style={{ display: 'block' }}>
                  {m.hint}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <label className="label">Preview path</label>
        <input className="input mono" value={previewPath} onChange={(e) => setPreviewPath(e.target.value)} placeholder="index.html" />
        <div className="hint">The file the Preview tab opens, e.g. dist/index.html after a Vite build.</div>
      </div>
    </Modal>
  );
}
