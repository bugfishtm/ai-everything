// Pieces of the 3D editor that are not panels of their own: the "Add" list, the export dialog, the Scene tab.
import { Box, Camera, CircleAlert, Combine, Download, FileBox, Group, Package, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, downloadUrl, errMsg, rawUrl } from '../api';
import { Modal, Spinner } from '../components/ui';
import { basename, formatBytes } from '../util';
import { Num, Row, Section, Select, Text, Vec } from './fields';
import type { EditorCtx } from './params';
import { isObj } from './sceneDoc';
import type { Catalog, ExportReport, SceneModel, Vec3 } from './types';

type Spec = Record<string, unknown>;

export interface AddChoice {
  kind: 'shape' | 'group' | 'boolean' | 'pack' | 'model';
  label: string;
  hint: string;
  group: string;
  spec: Spec;
  name: string;
}

function choices(catalog: Catalog | null, models: string[]): AddChoice[] {
  const out: AddChoice[] = [];
  for (const s of catalog?.shapes ?? []) {
    out.push({ kind: 'shape', label: s.name, hint: s.doc, group: s.group, name: s.name, spec: { shape: s.name, ...(s.starter ?? {}) } });
  }
  out.push({ kind: 'group', label: 'group', hint: 'An empty group: objects in it move, turn and scale together', group: 'Structure', name: 'group', spec: { group: [] } });
  out.push({
    kind: 'boolean',
    label: 'boolean (cut / join)',
    hint: 'A box with a ball cut out of it — change the parts, or select two objects and use “Combine” instead',
    group: 'Structure',
    name: 'solid',
    spec: { boolean: { op: 'difference', objects: [{ shape: 'box', size: [1, 1, 1] }, { shape: 'sphere', radius: 0.6, position: [0.5, 0.5, 0.5] }] } },
  });
  for (const p of catalog?.packs.objects ?? []) {
    if (p.locked) continue;
    out.push({ kind: 'pack', label: p.name, hint: `${p.use} (${p.kind})${p.tags.length ? ` — ${p.tags.join(', ')}` : ''}`, group: `Pack: ${p.pack}`, name: p.use.split('/')[1] ?? 'item', spec: { use: p.use } });
  }
  for (const m of models) {
    out.push({ kind: 'model', label: basename(m), hint: m, group: 'Model files of this project', name: basename(m).split('.')[0], spec: { model: m } });
  }
  return out;
}

function ChoiceIcon({ kind }: { kind: AddChoice['kind'] }) {
  if (kind === 'group') return <Group size={14} />;
  if (kind === 'boolean') return <Combine size={14} />;
  if (kind === 'pack') return <Package size={14} />;
  if (kind === 'model') return <FileBox size={14} />;
  return <Box size={14} />;
}

/** Everything that can be added to the scene, in one searchable list. */
export function AddMenu({ catalog, models, onAdd, onClose, into }: { catalog: Catalog | null; models: string[]; onAdd: (c: AddChoice) => void; onClose: () => void; into: string | null }) {
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const all = useMemo(() => choices(catalog, models), [catalog, models]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = all.filter((c) => words.every((w) => `${c.label} ${c.hint} ${c.group}`.toLowerCase().includes(w)));
  const groups = [...new Set(list.map((c) => c.group))];
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const t = setTimeout(() => window.addEventListener('mousedown', close), 0);
    window.addEventListener('keydown', esc);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  return (
    <div className="s3-add" ref={ref} onKeyDown={(e) => e.stopPropagation()}>
      <div className="s3-add-search">
        <Search size={13} />
        <input
          autoFocus
          placeholder="box, tree, lathe …"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && list[0]) onAdd(list[0]);
          }}
        />
      </div>
      {into && <div className="s3-hint pad">New objects go into the selected group “{into}”.</div>}
      <div className="s3-add-list">
        {!catalog && (
          <div className="center" style={{ padding: 16 }}>
            <Spinner />
          </div>
        )}
        {groups.map((g) => (
          <div key={g}>
            <div className="s3-add-group">{g}</div>
            <div className="s3-add-items">
              {list
                .filter((c) => c.group === g)
                .map((c) => (
                  <button key={`${c.kind}:${c.label}:${c.hint}`} className="s3-add-item" title={c.hint} onClick={() => onAdd(c)}>
                    <ChoiceIcon kind={c.kind} />
                    <span className="ellipsis">{c.label}</span>
                  </button>
                ))}
            </div>
          </div>
        ))}
        {catalog && !list.length && <div className="s3-hint pad">Nothing matches. A shape that does not exist yet? Ask the AI to write a plugin (plugins/3d/) — it appears here.</div>}
      </div>
    </div>
  );
}

const FORMATS: { id: 'glb' | 'obj' | 'stl' | 'ply'; label: string; hint: string }[] = [
  { id: 'glb', label: '.glb', hint: 'games, the web, the asset library — with materials and textures' },
  { id: 'obj', label: '.obj', hint: 'other 3D programs (a folder with .obj, .mtl and the textures)' },
  { id: 'stl', label: '.stl', hint: '3D printing (shape only)' },
  { id: 'ply', label: '.ply', hint: 'scanning and research tools (shape only)' },
];

export function ExportDialog({
  projectId,
  path,
  text,
  onClose,
  onOpenFile,
  save,
}: {
  projectId: number;
  path: string;
  text: () => string;
  onClose: () => void;
  onOpenFile?: (p: string) => void;
  save: () => void | Promise<void>;
}) {
  const [formats, setFormats] = useState<Set<string>>(new Set(['glb']));
  const [name, setName] = useState(basename(path).split('.')[0] || 'model');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ExportReport | null>(null);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await save(); // the export is built from this text: keep the file the same as what was exported
      const r = await api<ExportReport>(`/projects/${projectId}/3d/export`, { body: { path, text: text(), formats: [...formats], preview: true, name: name.trim() || undefined } });
      setReport(r);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const v = Date.now();
  return (
    <Modal
      title="Build and export"
      onClose={onClose}
      icon={<Download size={18} />}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" disabled={busy || !formats.size} onClick={() => void run()}>
            {busy ? <Spinner size={14} /> : <Download size={15} />} Build
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="col" style={{ gap: 6 }}>
          {FORMATS.map((f) => (
            <label key={f.id} className="row" style={{ gap: 8, alignItems: 'baseline' }}>
              <input
                type="checkbox"
                checked={formats.has(f.id)}
                onChange={(e) => {
                  const next = new Set(formats);
                  if (e.target.checked) next.add(f.id);
                  else next.delete(f.id);
                  setFormats(next);
                }}
              />
              <b className="mono" style={{ width: 42 }}>
                {f.label}
              </b>
              <span className="muted small">{f.hint}</span>
            </label>
          ))}
        </div>
        <label className="row" style={{ gap: 8 }}>
          <span className="muted small" style={{ width: 70 }}>
            file name
          </span>
          <input className="input" style={{ height: 30 }} value={name} onChange={(e) => setName(e.target.value)} />
          <span className="faint small">in exports/</span>
        </label>
        {error && (
          <div className="notice error">
            <CircleAlert size={16} />
            <span style={{ whiteSpace: 'pre-wrap' }}>{error}</span>
          </div>
        )}
        {report && (
          <div className="col" style={{ gap: 8 }}>
            <b>
              Built · {report.stats.triangles.toLocaleString()} triangles · {report.objects} objects
              {report.stats.bounds ? ` · ${report.stats.bounds.size.map((n) => n.toFixed(2)).join(' × ')} m` : ''} · {formatBytes(report.bytes)} · {report.build_seconds}s
            </b>
            <div className="row wrap" style={{ gap: 6 }}>
              {Object.entries(report.files)
                .filter(([k]) => k !== 'preview')
                .map(([k, f]) => (
                  <span key={k} className="row" style={{ gap: 2 }}>
                    <button className="chip" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => onOpenFile?.(f)} title="Open">
                      {f}
                    </button>
                    <a className="btn sm ghost icon" href={downloadUrl(projectId, f)} title="Download">
                      <Download size={13} />
                    </a>
                  </span>
                ))}
            </div>
            {report.warnings.length > 0 && (
              <ul className="small" style={{ margin: 0, paddingLeft: 18, color: 'var(--warn)' }}>
                {report.warnings.slice(0, 10).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            {report.files.preview && <img src={`${rawUrl(projectId, report.files.preview)}?v=${v}`} alt="preview" style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--border)' }} />}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** The Scene tab: name and options, the preview camera, what the build says. */
export function ScenePanel({
  ctx,
  model,
  onSelect,
  cameraFromView,
  viewFromCamera,
}: {
  ctx: EditorCtx;
  model: SceneModel | null;
  onSelect: (id: string) => void;
  cameraFromView: () => void;
  viewFromCamera: () => void;
}) {
  const { doc, edit } = ctx;
  const scene = doc.get(['scene']);
  const s: Spec = isObj(scene) ? scene : {};
  const cam = doc.get(['camera']);
  const c: Spec = isObj(cam) ? cam : {};
  const put = (k: string, v: unknown, done = true) => edit((d) => (v === undefined ? d.delete(['scene', k]) : d.set(['scene', k], v)), done ? undefined : `scene:${k}`);
  const v3 = (v: unknown): Vec3 | null => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number') ? (v as Vec3) : null);
  const stats = model?.stats;
  return (
    <div className="s3-inspector">
      <Section title="Scene">
        <Row label="name">
          <Text value={typeof s.name === 'string' ? s.name : ''} placeholder={basename(ctx.path).split('.')[0]} onChange={(v) => put('name', v.trim() || undefined)} />
        </Row>
        <Row label="smooth angle" title="Edges sharper than this stay hard, softer ones are shaded round (degrees) — for every object that does not say otherwise" set={s.smooth_angle !== undefined} onReset={() => put('smooth_angle', undefined)}>
          <Num value={typeof s.smooth_angle === 'number' ? s.smooth_angle : null} label="↔" min={0} max={180} step={5} placeholder="40" onChange={(v, done) => put('smooth_angle', v, done)} />
        </Row>
        <Row label="textures" title="png: exact · jpg: much smaller files (for color textures without transparency)">
          <Select value={typeof s.texture_format === 'string' ? s.texture_format : ''} placeholder="png (exact)" options={[{ value: 'jpg', label: 'jpg (small files)' }]} onChange={(v) => put('texture_format', v || undefined)} />
        </Row>
        <Row label="largest" title="Textures bigger than this are scaled down when the scene is built (pixels)" set={s.texture_max !== undefined} onReset={() => put('texture_max', undefined)}>
          <Select value={typeof s.texture_max === 'number' ? String(s.texture_max) : ''} placeholder="2048" options={['256', '512', '1024', '2048', '4096']} onChange={(v) => put('texture_max', v ? Number(v) : undefined)} />
        </Row>
      </Section>
      <Section
        title="Preview camera"
        actions={
          <button className="icon-mini" title="Use the view you are looking through now" onClick={cameraFromView}>
            <Camera size={12} />
          </button>
        }
      >
        <div className="s3-hint">Where the perspective picture of the preview is taken from (what the AI looks at after a build).</div>
        {v3(c.position) ? (
          <>
            <Row label="position">
              <Vec value={v3(c.position)!} step={0.25} onChange={(v, done) => edit((d) => d.set(['camera', 'position'], v), done ? undefined : 'cam:position')} />
            </Row>
            <Row label="looks at">
              <Vec value={v3(c.target) ?? [0, 0, 0]} step={0.25} onChange={(v, done) => edit((d) => d.set(['camera', 'target'], v), done ? undefined : 'cam:target')} />
            </Row>
            <div className="row" style={{ gap: 6, padding: '4px 10px 8px' }}>
              <button className="btn sm" onClick={viewFromCamera}>
                Look through it
              </button>
              <button className="btn sm ghost" onClick={() => edit((d) => d.delete(['camera']))}>
                Remove
              </button>
            </div>
          </>
        ) : (
          <div style={{ padding: '4px 10px 8px' }}>
            <button className="btn sm" onClick={cameraFromView}>
              <Camera size={13} /> Set from this view
            </button>
          </div>
        )}
      </Section>
      <Section title="Build">
        {stats ? (
          <div className="s3-stats">
            <span>triangles</span>
            <b>{stats.triangles.toLocaleString()}</b>
            <span>vertices</span>
            <b>{stats.vertices.toLocaleString()}</b>
            <span>objects</span>
            <b>
              {model!.counts.objects} ({model!.counts.instances} placed)
            </b>
            <span>materials</span>
            <b>
              {stats.materials.length}
              {stats.textures ? ` · ${stats.textures} texture map${stats.textures === 1 ? '' : 's'}` : ''}
            </b>
            {stats.bounds && (
              <>
                <span>size</span>
                <b>{stats.bounds.size.map((n) => n.toFixed(2)).join(' × ')} m</b>
              </>
            )}
            <span>.glb</span>
            <b>
              {formatBytes(model!.bytes)} · built in {model!.seconds}s
            </b>
          </div>
        ) : (
          <div className="s3-hint">Not built yet.</div>
        )}
        {stats?.bounds && stats.bounds.min[1] < -0.01 && <div className="s3-hint warn">The model reaches below the ground (lowest point y = {stats.bounds.min[1].toFixed(2)}).</div>}
      </Section>
      {model && (model.errors.length > 0 || model.warnings.length > 0 || model.pluginErrors.length > 0) && (
        <Section title={`Messages (${model.errors.length + model.warnings.length + model.pluginErrors.length})`}>
          <div className="s3-messages">
            {model.errors.map((e, i) => (
              <button key={`e${i}`} className="s3-msg err" onClick={() => e.id && !e.id.startsWith('materials.') && onSelect(e.id)}>
                {e.error}
              </button>
            ))}
            {model.pluginErrors.map((e, i) => (
              <div key={`p${i}`} className="s3-msg err">
                plugin {e.file}: {e.error}
              </div>
            ))}
            {model.warnings.map((w, i) => (
              <div key={`w${i}`} className="s3-msg warn">
                {w}
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
