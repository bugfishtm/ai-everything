// Everything about the selected object: what it is, where it is, what it is made of.
import { ArrowDown, ArrowDownToLine, ArrowUp, CircleAlert, CornerLeftUp, Lock, LockOpen, Pencil, X } from 'lucide-react';
import { useState } from 'react';
import { DataField, Num, Row, Section, Select, Text, Vec } from './fields';
import { KindIcon } from './Outliner';
import { type EditorCtx, ParamField } from './params';
import { addMaterial, isObj, materialNames, paramsOf, setField, setParam, setTransform, transformOf, uniqueName, type ObjNode } from './sceneDoc';
import type { CatalogEntry, Transform, Vec3 } from './types';

type Spec = Record<string, unknown>;

function uvOf(raw: unknown): Spec {
  if (typeof raw === 'string') return { projection: raw };
  return isObj(raw) ? raw : {};
}

/** Write UV settings the short way when only the projection is set. */
function uvValue(u: Spec): unknown {
  const keys = Object.keys(u).filter((k) => u[k] !== undefined && u[k] !== '');
  if (!keys.length) return undefined;
  if (keys.length === 1 && keys[0] === 'projection') return u.projection;
  const out: Spec = {};
  for (const k of ['projection', 'axis', 'scale', 'repeat', 'offset', 'rotation']) if (u[k] !== undefined && u[k] !== '') out[k] = u[k];
  return out;
}

export function UvFields({ value, onChange, catalog, inherit }: { value: unknown; onChange: (v: unknown, done: boolean) => void; catalog: EditorCtx['catalog']; inherit: string }) {
  const u = uvOf(value);
  const proj = typeof u.projection === 'string' ? u.projection.replace(/-(x|y|z)$/, '') : '';
  const set = (k: string, v: unknown, done = true) => onChange(uvValue({ ...u, [k]: v }), done);
  const pair = (v: unknown, d: number): number[] => (typeof v === 'number' ? [v, v] : Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number') ? (v as number[]) : [d, d]);
  const wraps = proj === 'cylinder' || proj === 'sphere' || proj === 'fit';
  return (
    <>
      <Row label="projection" title={proj && catalog?.projections[proj] ? catalog.projections[proj] : 'How the picture is laid onto the surface'}>
        <Select value={proj} placeholder={inherit} options={Object.keys(catalog?.projections ?? { box: '', planar: '', cylinder: '', sphere: '', fit: '', mesh: '' })} onChange={(v) => set('projection', v || undefined)} />
      </Row>
      {(proj === 'planar' || wraps) && (
        <Row label="axis" title="planar: the direction it is projected along · cylinder / sphere: the axis it wraps around · fit: the side it is seen from">
          <Select value={typeof u.axis === 'string' ? u.axis : ''} placeholder={proj === 'planar' ? 'y (from above)' : proj === 'fit' ? 'z (front)' : 'y (upright)'} options={['x', 'y', 'z']} onChange={(v) => set('axis', v || undefined)} />
        </Row>
      )}
      {proj !== 'fit' && (
        <Row label="scale" title="Metres per repeat of the picture (bigger = bigger bricks)" set={u.scale !== undefined} onReset={() => set('scale', undefined)}>
          <Vec
            value={pair(u.scale, 1)}
            labels={['U', 'V']}
            step={0.1}
            min={0.001}
            onChange={(v, done) => set('scale', v[0] === v[1] ? v[0] : v, done)}
          />
        </Row>
      )}
      {wraps && (
        <Row label="repeat" title="How often the picture repeats: around and upwards (empty: from the scale)" set={u.repeat !== undefined} onReset={() => set('repeat', undefined)}>
          <Vec value={pair(u.repeat, 1)} labels={['U', 'V']} step={1} min={0.01} onChange={(v, done) => set('repeat', v, done)} />
        </Row>
      )}
      <Row label="offset" title="Shift the picture (1 = one whole repeat)" set={u.offset !== undefined} onReset={() => set('offset', undefined)}>
        <Vec value={pair(u.offset, 0)} labels={['U', 'V']} step={0.05} onChange={(v, done) => set('offset', v[0] === 0 && v[1] === 0 ? undefined : v, done)} />
      </Row>
      <Row label="rotation" title="Turn the picture (degrees)" set={u.rotation !== undefined} onReset={() => set('rotation', undefined)}>
        <Num value={typeof u.rotation === 'number' ? u.rotation : 0} label="↔" step={5} onChange={(v, done) => set('rotation', v || undefined, done)} />
      </Row>
    </>
  );
}

function EntryParams({
  entry,
  values,
  written,
  onChange,
  keyPrefix,
}: {
  entry: Pick<CatalogEntry, 'params' | 'ui'>;
  values: Spec;
  written: (k: string) => boolean;
  onChange: (k: string, v: unknown, done: boolean) => void;
  keyPrefix: string;
}) {
  return (
    <>
      {Object.entries(entry.params).map(([k, def]) => (
        <ParamField
          key={keyPrefix + k}
          name={k}
          value={values[k]}
          def={def}
          hint={entry.ui?.[k]}
          set={written(k)}
          onChange={(v, done) => onChange(k, v, done)}
          onReset={() => onChange(k, undefined, true)}
        />
      ))}
    </>
  );
}

export function Inspector({ ctx, node, live }: { ctx: EditorCtx; node: ObjNode; live: Transform | null }) {
  const { catalog, model, edit } = ctx;
  const [uniform, setUniform] = useState(true);
  const spec = node.spec;
  const rec = ctx.fresh ? model?.objects[node.id] : undefined;
  const t = live ?? transformOf(spec);
  const key = (what: string) => `${what}:${node.id}`;
  const put = (k: string, v: unknown, done = true) => edit((d) => setField(d, node.path, k, v), done ? undefined : key(k));

  // what the object is
  const shapeName = node.kind === 'shape' || (node.kind === 'use' && !node.type.includes('/')) ? node.type : null;
  const entry = shapeName ? catalog?.shapes.find((s) => s.name === shapeName) : undefined;
  const packItem = node.kind === 'use' && node.type.includes('/') ? catalog?.packs.objects.find((p) => p.use === node.type) : undefined;
  const { values, inParams } = paramsOf(spec);
  const known = entry?.params ?? packItem?.params ?? {};
  const extra = Object.keys(values).filter((k) => !(k in known));
  const groups = [...new Set((catalog?.shapes ?? []).map((s) => s.group))];

  const changeShape = (name: string) => {
    const next = catalog?.shapes.find((s) => s.name === name);
    edit((d) => {
      let x = d.set([...node.path, node.kind === 'use' ? 'use' : 'shape'], name);
      if (!next) return x;
      // parameters the new shape does not have go; data it cannot exist without comes
      for (const k of Object.keys(values)) if (!(k in next.params)) x = inParams.has(k) ? x.delete([...node.path, 'params', k]) : x.delete([...node.path, k]);
      for (const [k, v] of Object.entries(next.starter ?? {})) if (!(k in values)) x = x.set([...node.path, k], v);
      const left = x.get([...node.path, 'params']);
      if (isObj(left) && !Object.keys(left).length) x = x.delete([...node.path, 'params']);
      return x;
    });
  };

  // material
  const mat = spec.material;
  const matName = typeof mat === 'string' ? mat : null;
  const sceneMats = materialNames(ctx.doc);
  let inherited: string | null = null;
  if (mat === undefined) for (let p = node.parent; p && !inherited; p = p.parent) if (typeof p.spec.material === 'string') inherited = p.spec.material;
  const shown = matName ?? inherited;
  const swatch = shown ? (model?.materials[shown]?.color ?? catalog?.presets[shown]?.color ?? catalog?.packs.materials.find((m) => m.use === shown)?.color) : undefined;
  const hasMaps = !!shown && (model?.materials[shown]?.maps.length ?? 0) > 0;

  const newMaterial = async () => {
    const name = await ctx.prompt('New material', uniqueName([], `${node.label.replace(/[^\w-]+/g, '-')}-material`), 'Name');
    if (!name) return;
    const base: Spec = isObj(mat) ? mat : matName && !sceneMats.includes(matName) ? { use: matName } : { color: swatch ?? '#cfd3da', roughness: 0.6 };
    if (edit((d) => setField(addMaterial(d, name.trim(), base), node.path, 'material', name.trim()))) ctx.openMaterial(name.trim());
  };

  // modifiers
  const mods: (string | Spec)[] = Array.isArray(spec.modifiers) ? (spec.modifiers as (string | Spec)[]) : [];
  const modName = (m: string | Spec) => (typeof m === 'string' ? m : String(m.type ?? m.use ?? ''));
  const writeMods = (list: (string | Spec)[], coalesce?: string) =>
    edit(
      (d) =>
        setField(
          d,
          node.path,
          'modifiers',
          list.length
            ? list.map((m) => {
                if (typeof m === 'string') return m;
                const { type, use, ...rest } = m;
                const name = String(type ?? use ?? '');
                return Object.keys(rest).length ? { type: name, ...rest } : name;
              })
            : undefined,
        ),
      coalesce,
    );

  // copies
  const copies = isObj(spec.repeat) ? 'repeat' : isObj(spec.scatter) ? 'scatter' : 'none';
  const rep = isObj(spec.repeat) ? spec.repeat : {};
  const sca = isObj(spec.scatter) ? spec.scatter : {};
  const v3 = (v: unknown, d: number): Vec3 => (typeof v === 'number' ? [v, v, v] : Array.isArray(v) && v.length === 3 ? (v as Vec3) : [d, d, d]);
  const setCopy = (which: 'repeat' | 'scatter', k: string, v: unknown, done = true) =>
    edit((d) => (v === undefined ? d.delete([...node.path, which, k]) : d.set([...node.path, which, k], v)), done ? undefined : key(`${which}.${k}`));

  return (
    <div className="s3-inspector">
      <div className="s3-insp-head">
        <span className="s3-out-icon">
          <KindIcon kind={node.kind} size={16} />
        </span>
        <Text value={typeof spec.name === 'string' ? spec.name : ''} placeholder={`${node.type} (no name)`} onChange={(v) => put('name', v.trim() || undefined)} />
        {node.parent && (
          <button className="icon-mini" title={`Select the ${node.parent.kind} it is in: ${node.parent.label}`} onClick={() => ctx.select([node.parent!.id])}>
            <CornerLeftUp size={13} />
          </button>
        )}
      </div>
      <div className="s3-insp-sub faint small">
        {node.operand ? `part of the boolean “${node.parent?.label}”` : node.kind}
        {rec?.triangles !== undefined && ` · ${rec.triangles.toLocaleString()} triangles`}
        {(rec?.instances ?? 1) > 1 && ` · ${rec!.instances} copies`}
        {spec.visible === false && ' · hidden'}
      </div>
      {rec?.error && (
        <div className="notice error s3-notice">
          <CircleAlert size={15} />
          <span>{rec.error}</span>
        </div>
      )}

      <Section title="Transform" actions={
        <>
          {!node.operand && (
            <button className="icon-mini" title="Stand on the ground (y = 0)" onClick={() => ctx.dropToGround(node)}>
              <ArrowDownToLine size={12} />
            </button>
          )}
          <button className="icon-mini" title="Reset position, rotation and scale" onClick={() => edit((d) => setTransform(d, node.path, { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }))}>
            <X size={12} />
          </button>
        </>
      }>
        <Row label="position" title="Metres; shapes stand on y = 0">
          <Vec value={t.position} step={0.05} onChange={(v, done) => edit((d) => setTransform(d, node.path, { position: v as Vec3 }), done ? undefined : key('position'))} />
        </Row>
        <Row label="rotation" title="Degrees around x, y, z">
          <Vec value={t.rotation} step={5} onChange={(v, done) => edit((d) => setTransform(d, node.path, { rotation: v as Vec3 }), done ? undefined : key('rotation'))} />
        </Row>
        <Row label={
          <span className="row" style={{ gap: 4 }}>
            scale
            <button className="icon-mini" title={uniform ? 'All sides together — click to scale each side on its own' : 'Each side on its own — click to scale all sides together'} onClick={() => setUniform(!uniform)}>
              {uniform ? <Lock size={10} /> : <LockOpen size={10} />}
            </button>
          </span>
        }>
          <Vec
            value={t.scale}
            step={0.05}
            onChange={(v, done) => {
              let next = v as Vec3;
              if (uniform) {
                const i = v.findIndex((x, k) => x !== t.scale[k]);
                if (i >= 0) {
                  const f = t.scale[i] ? v[i] / t.scale[i] : 1;
                  next = t.scale[i] ? (t.scale.map((x) => Math.round(x * f * 10000) / 10000) as Vec3) : [v[i], v[i], v[i]];
                }
              }
              edit((d) => setTransform(d, node.path, { scale: next }), done ? undefined : key('scale'));
            }}
          />
        </Row>
      </Section>

      {(shapeName || packItem || node.kind === 'use') && (
        <Section title={shapeName ? 'Shape' : 'Pack item'}>
          {shapeName ? (
            <Row label="shape" title={entry?.help ?? entry?.doc}>
              <select className="daw-input s3-select" value={shapeName} onChange={(e) => changeShape(e.target.value)}>
                {!entry && <option value={shapeName}>{shapeName} (unknown)</option>}
                {groups.map((g) => (
                  <optgroup key={g} label={g}>
                    {catalog!.shapes
                      .filter((s) => s.group === g)
                      .map((s) => (
                        <option key={s.name} value={s.name} title={s.doc}>
                          {s.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </Row>
          ) : (
            <Row label="use">
              <Select value={node.type} options={(catalog?.packs.objects ?? []).map((p) => ({ value: p.use, label: `${p.name} — ${p.use}` }))} onChange={(v) => v && put('use', v)} />
            </Row>
          )}
          {entry?.doc && <div className="s3-hint">{entry.doc}</div>}
          <EntryParams
            entry={{ params: known as Spec, ui: entry?.ui ?? {} }}
            values={values}
            written={(k) => k in values}
            keyPrefix={`${node.id}:${shapeName ?? node.type}:`}
            onChange={(k, v, done) => edit((d) => setParam(d, node, k, v), done ? undefined : key(`p.${k}`))}
          />
          {extra.map((k) => (
            <ParamField key={k} name={k} value={values[k]} def={undefined} set onChange={(v, done) => edit((d) => setParam(d, node, k, v), done ? undefined : key(`p.${k}`))} onReset={() => edit((d) => setParam(d, node, k, undefined))} doc="not a parameter of this shape — remove it with the arrow" />
          ))}
        </Section>
      )}

      {node.kind === 'model' && (
        <Section title="Model file">
          <Row label="file" title="A model of the project (glb, gltf, obj, stl, ply); it keeps its own materials unless you choose one below">
            <Select value={node.type} options={ctx.models} onChange={(v) => v && put('model', v)} />
          </Row>
        </Section>
      )}

      {node.kind === 'boolean' && (
        <Section title="Boolean">
          <Row label="operation" title="difference: the first part minus the others · union: all melted into one · intersection: only where they overlap">
            <Select
              value={node.type}
              options={['difference', 'union', 'intersection']}
              onChange={(v) => edit((d) => d.set([...node.path, 'boolean', 'op'], v))}
            />
          </Row>
          <div className="s3-hint">Its parts are listed below it on the left — select one to move or resize it. Parts should be closed volumes.</div>
        </Section>
      )}

      {node.kind === 'group' && <div className="s3-hint pad">A group moves, turns and scales its {node.children.length} object(s) together. Drag objects onto it in the list to add them.</div>}

      {!node.operand && (
        <Section title="Material">
          <Row label="material" title="A material of the scene, a preset or a pack material">
            <span className="row" style={{ gap: 6, minWidth: 0 }}>
              <span className={`s3-swatch${hasMaps ? ' tex' : ''}`} style={{ background: swatch ?? (isObj(mat) && typeof mat.color === 'string' ? mat.color : '#cfd3da') }} />
              <select
                className="daw-input s3-select"
                value={matName ?? (isObj(mat) ? '__inline' : '')}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '__new') void newMaterial();
                  else if (v !== '__inline') put('material', v || undefined);
                }}
              >
                <option value="">{inherited ? `from the group (${inherited})` : node.kind === 'model' || packItem ? 'its own materials' : 'default gray'}</option>
                {isObj(mat) && <option value="__inline">written here (only this object)</option>}
                {matName && !sceneMats.includes(matName) && !catalog?.presets[matName] && !catalog?.packs.materials.some((m) => m.use === matName) && <option value={matName}>{matName}</option>}
                {sceneMats.length > 0 && (
                  <optgroup label="Materials of this scene">
                    {sceneMats.map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </optgroup>
                )}
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
                <option value="__new">+ New material…</option>
              </select>
              {matName && sceneMats.includes(matName) && (
                <button className="icon-mini" title="Edit this material (color, texture, relief …)" onClick={() => ctx.openMaterial(matName)}>
                  <Pencil size={12} />
                </button>
              )}
            </span>
          </Row>
          {(matName && !sceneMats.includes(matName)) || isObj(mat) ? (
            <div className="s3-hint">
              <button className="link-btn" onClick={() => void newMaterial()}>
                Make it a material of this scene
              </button>{' '}
              to change its color or give it a texture.
            </div>
          ) : null}
        </Section>
      )}

      {!node.operand && node.kind !== 'group' && (hasMaps || spec.uv !== undefined) && (
        <Section title="Texture mapping" open={spec.uv !== undefined} badge={spec.uv !== undefined ? <span className="s3-dot" /> : undefined}>
          <div className="s3-hint">Only for this object — the material says how its texture is laid on by default.</div>
          <UvFields value={spec.uv} catalog={catalog} inherit="as the material says" onChange={(v, done) => put('uv', v, done)} />
        </Section>
      )}

      {node.kind !== 'group' && !node.operand && (
        <Section title="Shading" open={spec.shading !== undefined || spec.smooth_angle !== undefined}>
          <Row label="shading" title="auto: round surfaces smooth, sharp edges hard · flat: faceted (low-poly look) · smooth: everything round">
            <Select value={typeof spec.shading === 'string' ? spec.shading : ''} placeholder="auto" options={['flat', 'smooth']} onChange={(v) => put('shading', v || undefined)} />
          </Row>
          {spec.shading !== 'flat' && spec.shading !== 'smooth' && (
            <Row label="smooth angle" title="Edges sharper than this stay hard (degrees, default 40)" set={spec.smooth_angle !== undefined} onReset={() => put('smooth_angle', undefined)}>
              <Num value={typeof spec.smooth_angle === 'number' ? spec.smooth_angle : null} label="↔" min={0} max={180} step={5} placeholder="40" onChange={(v, done) => put('smooth_angle', v, done)} />
            </Row>
          )}
        </Section>
      )}

      {node.kind !== 'group' && (
        <Section
          title={`Modifiers${mods.length ? ` (${mods.length})` : ''}`}
          open={mods.length > 0}
          actions={
            <select className="daw-input s3-add-select" value="" title="Add a modifier (applied in order, before the object is placed)" onChange={(e) => e.target.value && writeMods([...mods, e.target.value])}>
              <option value="">+ add</option>
              {(catalog?.modifiers ?? []).map((m) => (
                <option key={m.name} value={m.name} title={m.doc}>
                  {m.name}
                </option>
              ))}
            </select>
          }
        >
          {!mods.length && <div className="s3-hint">Bend, twist, taper, roughen (noise), smooth, subdivide … applied to the shape in order.</div>}
          {mods.map((m, i) => {
            const name = modName(m);
            const me = catalog?.modifiers.find((x) => x.name === name);
            const mv: Spec = typeof m === 'string' ? {} : m;
            return (
              <div key={i} className="s3-mod">
                <div className="s3-mod-head">
                  <b>{name}</b>
                  <span className="faint small ellipsis">{me?.doc ?? 'unknown modifier'}</span>
                  <span className="spacer" />
                  <button className="icon-mini" disabled={i === 0} title="Earlier" onClick={() => writeMods(mods.map((x, k) => (k === i - 1 ? mods[i] : k === i ? mods[i - 1] : x)))}>
                    <ArrowUp size={11} />
                  </button>
                  <button className="icon-mini" disabled={i === mods.length - 1} title="Later" onClick={() => writeMods(mods.map((x, k) => (k === i + 1 ? mods[i] : k === i ? mods[i + 1] : x)))}>
                    <ArrowDown size={11} />
                  </button>
                  <button className="icon-mini" title="Remove" onClick={() => writeMods(mods.filter((_, k) => k !== i))}>
                    <X size={11} />
                  </button>
                </div>
                {me && (
                  <EntryParams
                    entry={me}
                    values={mv}
                    written={(k) => k in mv}
                    keyPrefix={`${node.id}:mod${i}:`}
                    onChange={(k, v, done) => {
                      const next: Spec = { type: name, ...mv };
                      if (v === undefined) delete next[k];
                      else next[k] = v;
                      writeMods(mods.map((x, j) => (j === i ? next : x)), done ? undefined : key(`mod${i}.${k}`));
                    }}
                  />
                )}
              </div>
            );
          })}
        </Section>
      )}

      {!node.operand && (
        <Section title="Copies" open={copies !== 'none'}>
          <Row label="copies" title="repeat: a row of copies, each one step further · scatter: copies strewn at random over an area">
            <Select
              value={copies}
              options={[
                { value: 'none', label: 'only this one' },
                { value: 'repeat', label: 'repeat (a row)' },
                { value: 'scatter', label: 'scatter (random)' },
              ]}
              onChange={(v) =>
                edit((d) => {
                  let x = d;
                  if (v !== 'repeat' && d.has([...node.path, 'repeat'])) x = x.delete([...node.path, 'repeat']);
                  if (v !== 'scatter' && d.has([...node.path, 'scatter'])) x = x.delete([...node.path, 'scatter']);
                  if (v === 'repeat' && copies !== 'repeat') x = x.set([...node.path, 'repeat'], { count: 3, offset: [1.5, 0, 0] });
                  if (v === 'scatter' && copies !== 'scatter') x = x.set([...node.path, 'scatter'], { count: 12, area: [10, 10], seed: 1, scale: [0.8, 1.2] });
                  return x;
                })
              }
            />
          </Row>
          {copies === 'repeat' && (
            <>
              <Row label="count">
                <Num value={typeof rep.count === 'number' ? rep.count : 2} label="↔" int min={1} max={5000} step={1} onChange={(v, done) => setCopy('repeat', 'count', v ?? 2, done)} />
              </Row>
              <Row label="step" title="How far each copy is from the one before (in the object's own directions)">
                <Vec value={v3(rep.offset, 0)} step={0.1} onChange={(v, done) => setCopy('repeat', 'offset', v, done)} />
              </Row>
              <Row label="turn" title="Each copy is turned this much more (degrees)" set={rep.rotate !== undefined} onReset={() => setCopy('repeat', 'rotate', undefined)}>
                <Vec value={v3(rep.rotate, 0)} step={5} onChange={(v, done) => setCopy('repeat', 'rotate', v, done)} />
              </Row>
              <Row label="grow" title="Each copy is scaled by this (1 = same size)" set={rep.scale !== undefined} onReset={() => setCopy('repeat', 'scale', undefined)}>
                <Vec value={v3(rep.scale, 1)} step={0.05} onChange={(v, done) => setCopy('repeat', 'scale', v[0] === v[1] && v[1] === v[2] ? v[0] : v, done)} />
              </Row>
            </>
          )}
          {copies === 'scatter' && (
            <>
              <Row label="count">
                <Num value={typeof sca.count === 'number' ? sca.count : 10} label="↔" int min={1} max={5000} step={1} onChange={(v, done) => setCopy('scatter', 'count', v ?? 10, done)} />
              </Row>
              <Row label="area" title="Width and depth of the area around the position (metres)">
                <Vec
                  value={typeof sca.area === 'number' ? [sca.area, sca.area] : Array.isArray(sca.area) && sca.area.length >= 2 ? [Number(sca.area[0]), Number(sca.area[sca.area.length - 1])] : [10, 10]}
                  labels={['X', 'Z']}
                  step={0.5}
                  min={0}
                  onChange={(v, done) => setCopy('scatter', 'area', v, done)}
                />
              </Row>
              <Row label="seed" title="Another number = another random arrangement">
                <Num value={typeof sca.seed === 'number' ? sca.seed : 1} label="↔" int min={0} step={1} onChange={(v, done) => setCopy('scatter', 'seed', v ?? 1, done)} />
              </Row>
              <Row label="size" title="Each copy gets a random size between these two factors">
                <Vec
                  value={typeof sca.scale === 'number' ? [sca.scale, sca.scale] : Array.isArray(sca.scale) && sca.scale.length === 2 ? (sca.scale as number[]) : [1, 1]}
                  labels={['min', 'max']}
                  step={0.05}
                  min={0.01}
                  onChange={(v, done) => setCopy('scatter', 'scale', v, done)}
                />
              </Row>
              <Row label="spacing" title="Smallest distance between two copies (metres)" set={sca.min_distance !== undefined} onReset={() => setCopy('scatter', 'min_distance', undefined)}>
                <Num value={typeof sca.min_distance === 'number' ? sca.min_distance : 0} label="↔" min={0} step={0.1} onChange={(v, done) => setCopy('scatter', 'min_distance', v || undefined, done)} />
              </Row>
              <Row label="turn" title="Turn every copy at random">
                <input type="checkbox" checked={sca.rotate !== false} onChange={(e) => setCopy('scatter', 'rotate', e.target.checked ? undefined : false)} />
              </Row>
              <div className="s3-wide" title="Places to keep free: [[x, z, radius], …] around the position">
                <div className="s3-row">
                  <span className={`s3-label${sca.avoid !== undefined ? ' set' : ''}`}>keep free</span>
                </div>
                <DataField value={sca.avoid} onChange={(v) => setCopy('scatter', 'avoid', v)} rows={1} />
              </div>
            </>
          )}
        </Section>
      )}

      <Section title="Note" open={typeof spec.note === 'string'}>
        <Text value={typeof spec.note === 'string' ? spec.note : ''} placeholder="a remark for people and the AI" onChange={(v) => put('note', v.trim() || undefined)} />
      </Section>
      {!node.operand && (
        <div className="s3-insp-foot">
          <button className="btn sm ghost" onClick={() => put('visible', spec.visible === false ? undefined : false)}>
            {spec.visible === false ? 'Show' : 'Hide'}
          </button>
          <span className="spacer" />
          <span className="faint small mono" title="Where this object is in the scene file">
            {node.id}
          </span>
        </div>
      )}
    </div>
  );
}
