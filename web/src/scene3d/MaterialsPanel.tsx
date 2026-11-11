// Materials of the scene: color, gloss, glow — and textures: image files, studio-image pictures and
// procedural textures (made by studio-image), relief, more maps, and how the picture lies on objects.
import { Copy, ExternalLink, Plus, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errMsg, upload } from '../api';
import { Spinner } from '../components/ui';
import { Color, DataField, Num, Row, Section, Select, Slider, Text } from './fields';
import { UvFields } from './Inspector';
import { type EditorCtx, ParamField } from './params';
import { addMaterial, deleteMaterial, isObj, materialNames, materialSpec, renameMaterial, setMaterialKey, usedBy, validName } from './sceneDoc';
import type { TexturePreview } from './types';

type Spec = Record<string, unknown>;

/** Ready-made surfaces: one click gives a material a texture, relief and a sensible scale. */
const LOOKS: Record<string, Spec> = {
  'Brick wall': { texture: { type: 'bricks', colors: ['#3a2b26', '#8f3f2c', '#b5563c'], width: 128, height: 64, mortar: 8, vary: 0.5 }, bump: 1.5, roughness: 0.9, texture_scale: 1.2 },
  'Wood grain': { texture: { type: 'wood', colors: ['#5a3a1e', '#a8763e'], rings: 7, grain: 0.4 }, bump: 0.5, roughness: 0.7, texture_scale: 1.5 },
  Floorboards: { texture: { type: 'stripes', colors: ['#4a2f18', '#8a5a2e'], width: 128, angle: 0, soft: 0.05, ratio: 0.94 }, bump: 0.8, roughness: 0.65, texture_scale: 1.2 },
  'Roof tiles': { texture: { type: 'bricks', colors: ['#3b1d14', '#9c4a32', '#c0633f'], width: 64, height: 96, mortar: 6, vary: 0.6, resolution: [512, 480] }, bump: 1.5, roughness: 0.85, texture_scale: 1.6 },
  'Floor tiles': { texture: { type: 'checker', colors: ['#d9d4c7', '#3b4252'], size: 64, resolution: 128 }, roughness: 0.25, texture_scale: 2 },
  Cobblestone: { texture: { type: 'cells', colors: ['#3c3c3a', '#8d8a82', '#b3afa6'], count: 50, edges: true }, bump: 2, roughness: 0.95, texture_scale: 1.5 },
  Concrete: { texture: { type: 'noise', colors: ['#7f7f7b', '#b5b5b0'], scale: 48, octaves: 5 }, bump: 0.3, roughness: 0.95, texture_scale: 2 },
  Marble: { texture: { type: 'marble', colors: ['#bdb8ae', '#f1eee8'], veins: 4 }, roughness: 0.2, texture_scale: 2 },
  Grass: { texture: { type: 'noise', colors: ['#2f5d27', '#6aa34a'], scale: 24, octaves: 4, contrast: 1.8 }, bump: 0.6, roughness: 1, texture_scale: 2 },
  Sand: { texture: { type: 'grain', colors: ['#c8b27c', '#e8d9a8'], amount: 0.6 }, roughness: 1, texture_scale: 1 },
  'Rusty metal': { texture: { type: 'clouds', colors: ['#5a2d16', '#9a5a2a', '#6f757c'], scale: 90, cover: 0.55 }, metallic: 0.8, roughness_map: { type: 'noise', scale: 32 }, bump: 0.4, texture_scale: 1.5 },
  Fabric: { texture: { type: 'grid', colors: ['#7a2f3a', '#9a4654'], spacing: 8, width: 2, resolution: 256 }, bump: 0.4, roughness: 1, texture_scale: 0.4 },
  Water: { texture: { type: 'waves', colors: ['#1e5f8a', '#5fb3d9'], length: 80, wobble: 0.5 }, bump: 0.6, roughness: 0.08, opacity: 0.85, texture_scale: 3 },
  Stripes: { texture: { type: 'stripes', colors: ['#c0392b', '#f4f1e8'], width: 64, angle: 0, resolution: 256 }, roughness: 0.5, texture_scale: 1 },
};

type SourceKind = 'none' | 'file' | 'picture' | 'procedural' | 'layers' | 'pack';

function kindOf(v: unknown): SourceKind {
  if (v === undefined || v === null || v === '' || v === false) return 'none';
  if (isObj(v)) return 'layers' in v ? 'layers' : 'procedural';
  const s = String(v).toLowerCase();
  if (/\.image\.ya?ml$/.test(s)) return 'picture';
  if (/\.(png|jpe?g|webp|bmp|gif|tga|tiff?)$/.test(s)) return 'file';
  if (!s.includes('/') && !s.includes('.')) return 'procedural';
  return s.includes('.') ? 'file' : 'pack';
}

/** A small picture of a texture source, made by the engine (debounced; the same source is asked once). */
function usePreview(ctx: EditorCtx, source: unknown, as: 'color' | 'normal', strength?: number, pixel?: boolean) {
  const [state, setState] = useState<{ url?: string; error?: string; full?: [number, number]; loading: boolean }>({ loading: false });
  const key = JSON.stringify([source, as, strength, pixel]);
  const cache = useRef(new Map<string, TexturePreview>());
  useEffect(() => {
    if (kindOf(source) === 'none') {
      setState({ loading: false });
      return;
    }
    const show = (r: TexturePreview) =>
      setState(r.ok && r.file ? { url: `/api/projects/${ctx.projectId}/3d/cache/thumbs/${r.file}`, full: r.full, loading: false } : { error: r.error ?? 'no preview', loading: false });
    const hit = cache.current.get(key);
    if (hit) return show(hit);
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    const h = setTimeout(() => {
      api<TexturePreview>(`/projects/${ctx.projectId}/3d/texture`, { body: { source, size: 192, as, strength, pixel, path: ctx.path } })
        .then((r) => {
          cache.current.set(key, r);
          if (alive) show(r);
        })
        .catch((err) => alive && setState({ error: errMsg(err), loading: false }));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ctx.projectId, ctx.path]);
  return state;
}

/** One texture source: nothing, an image file, a studio-image picture, or a procedural texture with its options. */
export function TextureField({
  ctx,
  value,
  onChange,
  as = 'color',
  strength,
  pixel,
  hint,
}: {
  ctx: EditorCtx;
  value: unknown;
  onChange: (v: unknown, done: boolean) => void;
  as?: 'color' | 'normal';
  strength?: number;
  pixel?: boolean;
  hint?: string;
}) {
  const kind = kindOf(value);
  const preview = usePreview(ctx, value, as, strength, pixel);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const procs = ctx.catalog?.textures ?? [];
  const proc: Spec = kind === 'procedural' ? (isObj(value) ? value : { type: String(value) }) : {};
  const procName = String(proc.type ?? proc.texture ?? '');
  const entry = procs.find((t) => t.name === procName);
  const setProc = (k: string, v: unknown, done = true) => {
    const next: Spec = { type: procName, ...proc };
    delete next.texture;
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange(next, done);
  };
  const colors: string[] = Array.isArray(proc.colors) && proc.colors.every((c) => typeof c === 'string') ? (proc.colors as string[]) : ['#000000', '#ffffff'];
  const files = ctx.pictures.filter((p) => p.kind === 'file');
  const pictures = ctx.pictures.filter((p) => p.kind === 'picture');

  const switchTo = (k: SourceKind) => {
    if (k === kind) return;
    if (k === 'none') onChange(undefined, true);
    else if (k === 'file') {
      if (files.length) onChange(files[0].path, true);
      else fileInput.current?.click();
    } else if (k === 'picture') {
      if (pictures.length) onChange(pictures[0].path, true);
      else void newPicture();
    } else if (k === 'procedural') onChange({ type: procs.some((t) => t.name === 'noise') ? 'noise' : (procs[0]?.name ?? 'noise') }, true);
  };

  const uploadFile = async (f: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', f);
      const r = await upload<{ saved?: string[] }>(`/projects/${ctx.projectId}/upload?dir=${encodeURIComponent('assets/textures')}`, form);
      const saved = r.saved?.[0] ?? `assets/textures/${f.name}`;
      ctx.reloadPictures();
      onChange(saved, true);
    } catch (err) {
      ctx.toast(errMsg(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const newPicture = async () => {
    const name = await ctx.prompt('New texture picture', 'texture', 'File name (a studio-image picture in src/)');
    if (!name) return;
    const stem = name.trim().replace(/\.image\.ya?ml$/i, '').replace(/[^\w.-]+/g, '-') || 'texture';
    setBusy(true);
    try {
      const r = await api<{ path: string }>(`/projects/${ctx.projectId}/tools/new`, { body: { path: `src/${stem}.image.yaml`, template: 'texture' } });
      ctx.reloadPictures();
      onChange(r.path, true);
      ctx.toast(`Created ${r.path} — open it to draw the texture`, 'ok');
    } catch (err) {
      ctx.toast(errMsg(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="s3-tex">
      <div className="s3-tex-top">
        <div className={`s3-tex-thumb${pixel ? ' pixel' : ''}`} title={preview.full ? `${preview.full[0]} × ${preview.full[1]} px` : undefined}>
          {preview.url ? <img src={preview.url} alt="" /> : kind === 'none' ? <span className="faint small">none</span> : preview.loading ? <Spinner size={14} /> : <span className="faint small">?</span>}
          {preview.loading && preview.url && (
            <span className="s3-tex-busy">
              <Spinner size={12} />
            </span>
          )}
        </div>
        <div className="s3-tex-main">
          <Select
            value={kind === 'pack' ? 'file' : kind}
            title={hint}
            options={[
              { value: 'none', label: 'no texture' },
              { value: 'procedural', label: 'procedural (generated)' },
              { value: 'file', label: 'image file' },
              { value: 'picture', label: 'picture (studio-image)' },
              ...(kind === 'layers' ? [{ value: 'layers', label: 'picture written here' }] : []),
            ]}
            onChange={(v) => switchTo(v as SourceKind)}
          />
          {kind === 'procedural' && (
            <select className="daw-input s3-select" value={procName} title={entry?.doc} onChange={(e) => onChange({ type: e.target.value, ...(proc.colors ? { colors: proc.colors } : {}), ...(proc.resolution ? { resolution: proc.resolution } : {}) }, true)}>
              {!entry && <option value={procName}>{procName} (unknown)</option>}
              {procs.map((t) => (
                <option key={t.name} value={t.name} title={t.doc}>
                  {t.name}
                  {t.source !== 'built-in' ? ' (plugin)' : ''}
                </option>
              ))}
            </select>
          )}
          {(kind === 'file' || kind === 'pack') && (
            <span className="row" style={{ gap: 4, minWidth: 0 }}>
              <Select value={String(value)} options={files.map((f) => f.path)} onChange={(v) => v && onChange(v, true)} />
              <button className="icon-mini" title="Upload an image (to assets/textures/)" disabled={busy} onClick={() => fileInput.current?.click()}>
                {busy ? <Spinner size={11} /> : <Upload size={12} />}
              </button>
            </span>
          )}
          {kind === 'picture' && (
            <span className="row" style={{ gap: 4, minWidth: 0 }}>
              <Select value={String(value)} options={pictures.map((f) => f.path)} onChange={(v) => v && onChange(v, true)} />
              <button className="icon-mini" title="Open the picture to edit it (it is rendered again when the scene is built)" onClick={() => ctx.openFile?.(String(value))}>
                <ExternalLink size={12} />
              </button>
              <button className="icon-mini" title="New texture picture" disabled={busy} onClick={() => void newPicture()}>
                <Plus size={12} />
              </button>
            </span>
          )}
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void uploadFile(f);
        }}
      />
      {preview.error && kind !== 'none' && <div className="s3-err">{preview.error}</div>}
      {kind === 'procedural' && (
        <div className="s3-tex-opts">
          {entry?.doc && <div className="s3-hint">{entry.doc}</div>}
          <Row label="colors" title="From dark to light: the pattern's values are turned into these colors">
            <span className="s3-colors">
              {colors.map((c, i) => (
                <span key={i} className="s3-color-chip">
                  <input
                    type="color"
                    value={/^#[0-9a-fA-F]{6}/.test(c) ? c.slice(0, 7) : '#888888'}
                    onInput={(e) => setProc('colors', colors.map((x, k) => (k === i ? (e.target as HTMLInputElement).value : x)), false)}
                    onChange={(e) => setProc('colors', colors.map((x, k) => (k === i ? e.target.value : x)))}
                  />
                  {colors.length > 2 && (
                    <button className="icon-mini" title="Remove this color" onClick={() => setProc('colors', colors.filter((_, k) => k !== i))}>
                      <X size={9} />
                    </button>
                  )}
                </span>
              ))}
              {colors.length < 6 && (
                <button className="icon-mini" title="Add a color" onClick={() => setProc('colors', [...colors, colors[colors.length - 1]])}>
                  <Plus size={11} />
                </button>
              )}
            </span>
          </Row>
          {entry &&
            Object.entries(entry.params).map(([k, def]) => (
              <ParamField key={`${procName}:${k}`} name={k} value={proc[k]} def={def} set={k in proc} onChange={(v, done) => setProc(k, v, done)} onReset={() => setProc(k, undefined)} />
            ))}
          <Row label="resolution" title="Size of the generated picture in pixels (512 is fine for most; 1024 for close-ups)" set={proc.resolution !== undefined} onReset={() => setProc('resolution', undefined)}>
            <Select value={String(typeof proc.resolution === 'number' ? proc.resolution : '')} placeholder="512" options={['64', '128', '256', '512', '1024', '2048']} onChange={(v) => setProc('resolution', v ? Number(v) : undefined)} />
          </Row>
          <Row label="seed" title="Another number = another random pattern" set={proc.seed !== undefined} onReset={() => setProc('seed', undefined)}>
            <Num value={typeof proc.seed === 'number' ? proc.seed : null} label="↔" int min={0} step={1} placeholder="1" onChange={(v, done) => setProc('seed', v, done)} />
          </Row>
        </div>
      )}
      {kind === 'layers' && (
        <div className="s3-tex-opts">
          <div className="s3-hint">A whole studio-image picture written in the scene file (size, background, layers).</div>
          <DataField value={value} onChange={(v) => onChange(v, true)} rows={4} />
        </div>
      )}
    </div>
  );
}

const MORE_MAPS: { key: string; label: string; hint: string; as?: 'normal' }[] = [
  { key: 'bump_map', label: 'Relief (height picture)', hint: 'White = high, black = low. Turned into a normal map; the strength is “relief” above.', as: 'normal' },
  { key: 'normal_map', label: 'Normal map', hint: 'A ready-made tangent-space normal map (the bluish kind). Wins over relief.' },
  { key: 'roughness_map', label: 'Roughness map', hint: 'White = rough, black = glossy. Multiplied with “roughness” (set that to 1 to use the map as it is).' },
  { key: 'metallic_map', label: 'Metal map', hint: 'White = metal. Multiplied with “metallic”.' },
  { key: 'emissive_map', label: 'Glow map', hint: 'What glows, in color (black = no glow) — windows at night, screens, lava cracks.' },
  { key: 'occlusion_map', label: 'Occlusion map', hint: 'Baked soft shadows: black = dark crevices.' },
];

export function MaterialsPanel({ ctx, selected, onSelect, sel }: { ctx: EditorCtx; selected: string | null; onSelect: (name: string | null) => void; sel: string[] }) {
  const { doc, tree, model, catalog, edit } = ctx;
  const names = materialNames(doc);
  const name = selected && names.includes(selected) ? selected : (names[0] ?? null);
  const raw = name ? doc.get(['materials', name]) : undefined;
  const spec = materialSpec(raw);
  const summary = name ? model?.materials[name] : undefined;
  const set = (k: string, v: unknown, done = true) => name !== null && edit((d) => setMaterialKey(d, name, k, v), done ? undefined : `mat:${name}:${k}`);
  const num = (k: string, d: number) => (typeof spec[k] === 'number' ? (spec[k] as number) : d);
  const users = name ? usedBy(tree, name) : [];
  const baseSummary = typeof spec.use === 'string' ? (catalog?.presets[spec.use] ?? model?.materials[spec.use]) : undefined;
  const hasTexture = kindOf(spec.texture) !== 'none';
  const selectedObjects = tree.length ? sel : [];

  const create = async (base?: Spec, suggested = 'material') => {
    let n = suggested;
    for (let i = 2; names.includes(n); i++) n = `${suggested}-${i}`;
    const input = await ctx.prompt('New material', n, 'Name');
    if (!input) return;
    try {
      const valid = validName(input);
      if (edit((d) => addMaterial(d, valid, base ?? { color: '#b8bcc4', roughness: 0.6 }))) onSelect(valid);
    } catch (err) {
      ctx.toast(errMsg(err), 'error');
    }
  };

  const assign = () => {
    if (!name) return;
    const nodes = selectedObjects.map((id) => findNode(tree, id)).filter((n): n is NonNullable<typeof n> => !!n && !n.operand);
    if (!nodes.length) return ctx.toast('Select objects first (in the list or in the view)', 'info');
    edit((d) => nodes.reduce((x, n) => x.set([...n.path, 'material'], name), d));
  };

  // the texture_* keys and `uv` say the same thing: the panel writes `uv` and removes the others
  const uvValue: Spec = {
    ...(spec.texture_scale !== undefined ? { scale: spec.texture_scale } : {}),
    ...(spec.texture_repeat !== undefined ? { repeat: spec.texture_repeat } : {}),
    ...(spec.texture_offset !== undefined ? { offset: spec.texture_offset } : {}),
    ...(spec.texture_rotation !== undefined ? { rotation: spec.texture_rotation } : {}),
    ...(typeof spec.uv === 'string' ? { projection: spec.uv } : isObj(spec.uv) ? spec.uv : {}),
  };
  const setUv = (v: unknown, done: boolean) => {
    if (name === null) return;
    edit(
      (d) => {
        let x = setMaterialKey(d, name, 'uv', v);
        for (const k of ['texture_scale', 'texture_repeat', 'texture_offset', 'texture_rotation']) if (spec[k] !== undefined) x = setMaterialKey(x, name, k, undefined);
        return x;
      },
      done ? undefined : `mat:${name}:uv`,
    );
  };

  return (
    <div className="s3-materials">
      <div className="s3-mat-list">
        {names.map((n) => {
          const s = model?.materials[n];
          return (
            <button key={n} className={`s3-mat-chip${n === name ? ' sel' : ''}`} onClick={() => onSelect(n)} title={s?.maps.length ? `textured: ${s.maps.join(', ')}` : undefined}>
              <span className={`s3-swatch${s?.maps.length ? ' tex' : ''}`} style={{ background: s?.color ?? '#cfd3da' }} />
              <span className="ellipsis">{n}</span>
            </button>
          );
        })}
        <button className="s3-mat-chip add" onClick={() => void create()} title="New material">
          <Plus size={13} /> New
        </button>
      </div>
      {!name ? (
        <div className="s3-hint pad">
          Materials say what objects are made of: a color, how glossy, a texture. Objects can also use the built-in presets (wood, stone, gold …) directly — make a material here to change one or give it a texture.
        </div>
      ) : (
        <div className="s3-mat-edit">
          <div className="s3-insp-head">
            <span className={`s3-swatch big${summary?.maps.length ? ' tex' : ''}`} style={{ background: summary?.color ?? '#cfd3da' }} />
            <Text
              value={name}
              onChange={(v) => {
                try {
                  const valid = validName(v);
                  if (edit((d) => renameMaterial(d, tree, name, valid))) onSelect(valid);
                } catch (err) {
                  ctx.toast(errMsg(err), 'error');
                }
              }}
            />
            <button className="icon-mini" title="Duplicate" onClick={() => void create(JSON.parse(JSON.stringify(spec)), `${name}-copy`)}>
              <Copy size={12} />
            </button>
            <button
              className="icon-mini"
              title="Delete this material"
              onClick={async () => {
                if (users.length && !(await ctx.confirm({ title: `Delete the material “${name}”?`, body: `${users.length} object(s) use it — they become default gray.`, confirm: 'Delete', danger: true }))) return;
                if (edit((d) => deleteMaterial(d, tree, name))) onSelect(null);
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
          <div className="s3-insp-sub small">
            {users.length ? (
              <button className="link-btn" onClick={() => ctx.select(users.map((u) => u.id))} title="Select them">
                used by {users.length} object{users.length === 1 ? '' : 's'}
              </button>
            ) : (
              <span className="faint">not used yet</span>
            )}
            {selectedObjects.length > 0 && (
              <>
                {' · '}
                <button className="link-btn" onClick={assign}>
                  give it to the selected object{selectedObjects.length === 1 ? '' : 's'}
                </button>
              </>
            )}
          </div>
          {summary?.error && <div className="notice error s3-notice">This material could not be read — see the messages above the view.</div>}

          <Section title="Surface">
            <Row label="based on" title="Start from a preset, a pack material or another material of this scene; everything set here wins">
              <select className="daw-input s3-select" value={typeof spec.use === 'string' ? spec.use : ''} onChange={(e) => set('use', e.target.value || undefined)}>
                <option value="">nothing</option>
                {typeof spec.use === 'string' && !catalog?.presets[spec.use] && !names.includes(spec.use) && !catalog?.packs.materials.some((m) => m.use === spec.use) && <option value={spec.use}>{spec.use}</option>}
                <optgroup label="Presets">
                  {Object.keys(catalog?.presets ?? {}).map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </optgroup>
                {(catalog?.packs.materials.length ?? 0) > 0 && (
                  <optgroup label="Packs">
                    {catalog!.packs.materials.map((m) => (
                      <option key={m.use} value={m.use}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {names.length > 1 && (
                  <optgroup label="This scene">
                    {names.filter((n) => n !== name).map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </Row>
            <Row label="color" title={hasTexture ? 'Multiplied with the texture (white = the texture as it is)' : 'The color of the surface'} set={spec.color !== undefined} onReset={() => set('color', undefined)}>
              <Color
                value={typeof spec.color === 'string' ? spec.color : undefined}
                placeholder={hasTexture ? '#ffffff' : (baseSummary?.color ?? '#cfd3da')}
                onChange={(v, done) => {
                  if (v) ctx.liveMaterial(name, { color: v });
                  set('color', v, done);
                }}
              />
            </Row>
            <Row label="roughness" title="0 = mirror-like, 1 = matt" set={spec.roughness !== undefined} onReset={() => set('roughness', undefined)}>
              <Slider
                value={num('roughness', baseSummary?.roughness ?? 0.6)}
                onChange={(v, done) => {
                  ctx.liveMaterial(name, { roughness: v });
                  set('roughness', v, done);
                }}
              />
            </Row>
            <Row label="metallic" title="0 = plastic, wood, stone … · 1 = metal" set={spec.metallic !== undefined} onReset={() => set('metallic', undefined)}>
              <Slider
                value={num('metallic', baseSummary?.metallic ?? 0)}
                onChange={(v, done) => {
                  ctx.liveMaterial(name, { metallic: v });
                  set('metallic', v, done);
                }}
              />
            </Row>
            <Row label="glow" title="The color it glows in (emissive)" set={spec.emissive !== undefined} onReset={() => set('emissive', undefined)}>
              <Color
                value={typeof spec.emissive === 'string' ? spec.emissive : undefined}
                allowNone
                placeholder="#000000"
                onChange={(v, done) => {
                  ctx.liveMaterial(name, { emissive: v ?? '' });
                  set('emissive', v, done);
                }}
              />
            </Row>
            {(spec.emissive !== undefined || spec.emissive_map !== undefined || spec.emissive_strength !== undefined) && (
              <Row label="glow strength" title="1 = normal; more makes it brighter than white (for bloom in games)" set={spec.emissive_strength !== undefined} onReset={() => set('emissive_strength', undefined)}>
                <Num value={num('emissive_strength', 1)} label="↔" min={0} max={100} step={0.5} onChange={(v, done) => set('emissive_strength', v === 1 ? undefined : v, done)} />
              </Row>
            )}
            <Row label="opacity" title="1 = solid, lower = see-through (glass, water)" set={spec.opacity !== undefined} onReset={() => set('opacity', undefined)}>
              <Slider
                value={num('opacity', baseSummary?.opacity ?? 1)}
                onChange={(v, done) => {
                  ctx.liveMaterial(name, { opacity: v });
                  set('opacity', v >= 1 && !baseSummary ? undefined : v, done);
                }}
              />
            </Row>
            {(hasTexture || spec.alpha !== undefined) && (
              <Row label="transparency" title="For textures with transparent parts — cutout: holes with hard edges (leaves, fences) · blend: soft see-through">
                <Select value={typeof spec.alpha === 'string' ? spec.alpha : ''} placeholder="automatic" options={['opaque', 'cutout', 'blend']} onChange={(v) => set('alpha', v || undefined)} />
              </Row>
            )}
            <Row label="both sides" title="Also visible from behind (thin things: leaves, paper, flags)">
              <Select
                value={spec.double_sided === true ? 'yes' : spec.double_sided === false ? 'no' : ''}
                placeholder="automatic"
                options={['yes', 'no']}
                onChange={(v) => set('double_sided', v === 'yes' ? true : v === 'no' ? false : undefined)}
              />
            </Row>
          </Section>

          <Section
            title="Texture"
            actions={
              <select
                className="daw-input s3-add-select"
                value=""
                title="A ready-made surface: texture, relief and scale in one click"
                onChange={(e) => {
                  const look = LOOKS[e.target.value];
                  if (!look) return;
                  edit((d) => {
                    let x = d;
                    for (const k of ['texture', 'bump', 'bump_map', 'roughness_map', 'metallic_map', 'normal_map', 'texture_scale', 'uv', 'color', 'opacity', 'metallic']) if (spec[k] !== undefined && !(k in look)) x = setMaterialKey(x, name, k, undefined);
                    for (const [k, v] of Object.entries(look)) x = setMaterialKey(x, name, k, v);
                    return x;
                  });
                }}
              >
                <option value="">looks…</option>
                {Object.keys(LOOKS).map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            }
          >
            <TextureField ctx={ctx} value={spec.texture} pixel={spec.texture_filter === 'nearest'} onChange={(v, done) => set('texture', v, done)} hint="The picture on the surface" />
            {(hasTexture || spec.bump !== undefined || spec.bump_map !== undefined) && (
              <Row label="relief" title="Makes the surface look raised where the texture is light (0 = flat, 1 = normal, 3 = deep)" set={spec.bump !== undefined} onReset={() => set('bump', undefined)}>
                <Slider value={typeof spec.bump === 'number' ? spec.bump : spec.bump === true || spec.bump_map !== undefined ? 1 : 0} min={0} max={4} step={0.1} onChange={(v, done) => set('bump', v || undefined, done)} />
              </Row>
            )}
            {hasTexture && (
              <>
                <Row label="pixels" title="smooth: blended (photos, most textures) · sharp: every pixel a hard square (pixel art)">
                  <Select value={spec.texture_filter === 'nearest' || spec.texture_filter === 'pixel' ? 'nearest' : ''} placeholder="smooth" options={[{ value: 'nearest', label: 'sharp (pixel art)' }]} onChange={(v) => set('texture_filter', v || undefined)} />
                </Row>
                <Row label="edges" title="What happens beyond the picture: repeat it, stop at its edge (clamp) or mirror it">
                  <Select value={typeof spec.texture_wrap === 'string' ? spec.texture_wrap : ''} placeholder="automatic" options={['repeat', 'clamp', 'mirror']} onChange={(v) => set('texture_wrap', v || undefined)} />
                </Row>
              </>
            )}
          </Section>

          {(hasTexture || MORE_MAPS.some((m) => spec[m.key] !== undefined) || spec.uv !== undefined) && (
            <Section title="Mapping" badge={<span className="faint small" style={{ marginLeft: 6 }}>how the picture lies on objects</span>}>
              <UvFields value={uvValue} catalog={catalog} inherit="box (all sides)" onChange={setUv} />
            </Section>
          )}

          <Section title="More maps" open={MORE_MAPS.some((m) => spec[m.key] !== undefined)} badge={MORE_MAPS.some((m) => spec[m.key] !== undefined) ? <span className="s3-dot" /> : undefined}>
            {MORE_MAPS.map((m) => (
              <div key={m.key} className="s3-map">
                <div className="s3-map-title" title={m.hint}>
                  {m.label}
                </div>
                <TextureField
                  ctx={ctx}
                  value={spec[m.key]}
                  as={m.as ?? 'color'}
                  strength={m.key === 'bump_map' && typeof spec.bump === 'number' ? spec.bump : undefined}
                  onChange={(v, done) => set(m.key, v, done)}
                  hint={m.hint}
                />
                {m.key === 'occlusion_map' && spec.occlusion_map !== undefined && (
                  <Row label="strength" set={spec.occlusion !== undefined} onReset={() => set('occlusion', undefined)}>
                    <Slider value={num('occlusion', 1)} onChange={(v, done) => set('occlusion', v, done)} />
                  </Row>
                )}
              </div>
            ))}
          </Section>
        </div>
      )}
    </div>
  );
}

function findNode(tree: EditorCtx['tree'], id: string): EditorCtx['tree'][number] | null {
  for (const n of tree) {
    if (n.id === id) return n;
    const c = findNode(n.children, id);
    if (c) return c;
  }
  return null;
}
