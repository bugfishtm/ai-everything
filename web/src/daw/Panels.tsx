import { AlertTriangle, Code2, Plus, Search, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Modal } from '../components/ui';
import { NumField, ParamControl, TextField } from './controls';
import { isBlackKey, midiName } from './notation';
import type { Catalog, DawInstrument, ParamSpec, SongModel } from './types';

const RESERVED = new Set(['use', 'params', 'file', 'root', 'pitched', 'kit', 'gain', 'pan', 'effects', 'octave', 'gate', 'volume', 'mute', 'solo', 'reverb', 'delay', 'sustain', 'sounds']);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function sourceLabel(source?: string): string {
  if (!source) return '';
  if (source === 'built-in') return 'built-in';
  if (source.startsWith('project:')) return `project plugin · ${source.slice(8)}`;
  if (source.startsWith('pack:')) return `pack plugin · ${source.slice(5)}`;
  return source;
}

// ---------------------------------------------------------------------------
// Sound picker
// ---------------------------------------------------------------------------
export interface PickChoice {
  use: string;
  name: string;
  group: string;
  doc: string;
  drum: boolean;
  params?: Record<string, unknown>;
}

export function choicesOf(catalog: Catalog | null): PickChoice[] {
  if (!catalog) return [];
  const out: PickChoice[] = [];
  for (const v of catalog.voices) {
    const group = v.source.startsWith('project:') ? '★ Plugins of this project' : v.source.startsWith('pack:') ? 'Pack plugins' : v.drum || v.kit ? 'Drums (built-in)' : 'Synths (built-in)';
    out.push({ use: v.name, name: v.name, group, doc: `${v.doc}${v.source !== 'built-in' ? ` — ${v.source}` : ''}`, drum: v.drum, params: v.params });
  }
  for (const p of catalog.packs) {
    if (p.kind === 'plugin' && catalog.voices.some((v) => v.source === `pack:${p.use}`)) continue;
    const kind = p.kind === 'instrument' ? 'SoundFont' : p.kind;
    out.push({ use: p.use, name: p.name, group: `${p.pack} (${p.kind === 'instrument' || p.kind === 'drumkit' ? 'SoundFont' : 'pack'})`, doc: `${kind}${p.family ? ` · ${p.family}` : ''}${p.tags.length ? ` · ${p.tags.join(', ')}` : ''}${p.codeAllowed === false ? ' · code not reviewed yet' : ''}`, drum: p.drum, params: p.params });
  }
  return out;
}

export function SoundPicker({ catalog, current, onPick, onClose, title = 'Choose a sound' }: { catalog: Catalog | null; current?: string | null; onPick: (c: PickChoice) => void; onClose: () => void; title?: string }) {
  const [q, setQ] = useState('');
  const all = useMemo(() => choicesOf(catalog), [catalog]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = all.filter((c) => words.every((w) => `${c.use} ${c.name} ${c.group} ${c.doc}`.toLowerCase().includes(w)));
  const groups = [...new Set(list.map((c) => c.group))].sort((a, b) => {
    const rank = (g: string) => (g.startsWith('★') ? 0 : g.startsWith('Synths') ? 1 : g.startsWith('Drums') ? 2 : g.startsWith('Pack plugins') ? 3 : 4);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return (
    <Modal title={title} onClose={onClose} size="medium">
      <div className="row" style={{ marginBottom: 10 }}>
        <Search size={15} className="faint" />
        <input className="input" autoFocus placeholder="piano, bass, kick, pad, 808, strings…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {!catalog && <div className="faint small">Loading instruments…</div>}
      <div className="picker">
        {groups.map((g) => (
          <div key={g}>
            <div className="picker-group">{g}</div>
            {list
              .filter((c) => c.group === g)
              .slice(0, q ? 200 : 60)
              .map((c) => (
                <button key={c.use} className={`picker-item${c.use === current ? ' sel' : ''}`} onClick={() => onPick(c)} title={c.use}>
                  <b>{c.name}</b>
                  <span className="faint small ellipsis">{c.doc}</span>
                  {c.drum && <span className="badge">drums</span>}
                </button>
              ))}
          </div>
        ))}
        {catalog && !list.length && <div className="faint small">Nothing matches “{q}”.</div>}
      </div>
    </Modal>
  );
}

/** A new spec for `use`, dropping parameters the new instrument does not know. */
export function specForUse(old: unknown, c: PickChoice): Record<string, unknown> {
  const base: Record<string, unknown> = isObj(old) ? { ...old } : {};
  delete base.kit;
  delete base.sounds;
  for (const k of Object.keys(base)) if (!RESERVED.has(k) && !(c.params && k in c.params)) delete base[k];
  if (isObj(base.params)) {
    const p = Object.fromEntries(Object.entries(base.params).filter(([k]) => c.params && k in c.params));
    if (Object.keys(p).length) base.params = p;
    else delete base.params;
  }
  if (!c.use.includes('/')) {
    delete base.root;
    delete base.pitched;
    delete base.sustain;
    delete base.file;
  }
  return { use: c.use, ...Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'use')) };
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------
interface InstProps {
  model: SongModel;
  catalog: Catalog | null;
  rawSpec: (name: string) => unknown;
  sel: string | null;
  soundErrors: Map<string, string>;
  onSelect: (name: string) => void;
  onParam: (name: string, key: string, value: unknown, done: boolean) => void;
  onSpec: (name: string, spec: Record<string, unknown>) => void;
  onRename: (name: string) => void;
  onDelete: (name: string) => void;
  onAdd: () => void;
  onAudition: (name: string, n: { p?: number; k?: string }) => void;
  onOpenFile?: (path: string) => void;
}

export function InstrumentsPanel(props: InstProps) {
  const { model, sel } = props;
  const names = Object.keys(model.instruments);
  const name = sel && model.instruments[sel] ? sel : names[0];
  const errors = model.pluginErrors ?? [];
  return (
    <div className="inst-panel">
      <div className="inst-list">
        {names.map((n) => {
          const ins = model.instruments[n];
          return (
            <button key={n} className={`inst-item${n === name ? ' sel' : ''}`} onClick={() => props.onSelect(n)} title={ins.describe}>
              <b className="ellipsis">{n}</b>
              <span className="faint small ellipsis">
                {ins.source?.startsWith('project:') && <span className="plug">★ </span>}
                {ins.use ?? (ins.kind === 'kit' ? 'kit' : ins.kind)}
              </span>
              {props.soundErrors.get(n) && <AlertTriangle size={12} color="var(--warn)" />}
            </button>
          );
        })}
        <button className="btn sm ghost" style={{ margin: 6 }} onClick={props.onAdd}>
          <Plus size={13} /> Instrument
        </button>
        {errors.length > 0 && (
          <div className="plugin-errors">
            <b className="small">Plugins that failed to load</b>
            {errors.map((e) => (
              <div key={e.file} className="small">
                <button className="link-btn mono" onClick={() => props.onOpenFile?.(e.file)}>
                  {e.file}
                </button>
                <div className="faint">{e.error}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      {name && <InstrumentEditor key={name} name={name} ins={model.instruments[name]} {...props} />}
    </div>
  );
}

function InstrumentEditor({ name, ins, ...props }: InstProps & { name: string; ins: DawInstrument }) {
  const [picking, setPicking] = useState(false);
  const raw = props.rawSpec(name);
  const spec: Record<string, unknown> = isObj(raw) ? raw : typeof raw === 'string' ? { use: raw } : {};
  const kit = isObj(spec.kit) ? (spec.kit as Record<string, unknown>) : null;
  const params = ins.params ?? {};
  const specs = ins.specs ?? {};
  const setIn = (k: string) => k in spec || (isObj(spec.params) && k in (spec.params as object));
  const voiceDefaults = props.catalog?.voices.find((v) => v.name === ins.voice)?.params ?? {};
  const err = props.soundErrors.get(name);
  const isProjectPlugin = ins.source?.startsWith('project:');
  const lowest = 12 * (Math.max(0, Math.min(7, ins.octave)) + 1);
  return (
    <div className="inst-edit">
      <div className="row wrap" style={{ gap: 8 }}>
        <h3 className="grow ellipsis">{name}</h3>
        <button className="btn sm ghost" onClick={() => props.onRename(name)}>
          Rename
        </button>
        <button className="btn sm ghost danger" onClick={() => props.onDelete(name)} title="Delete instrument (and its tracks)">
          <Trash2 size={13} />
        </button>
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        <span className="small faint">Sound</span>
        <button className="btn sm" onClick={() => setPicking(true)} title="Choose another instrument">
          {kit ? 'kit' : String(spec.use ?? ins.use ?? '?')}
        </button>
        <span className="small faint ellipsis" title={ins.describe}>
          {ins.describe}
          {ins.source && ins.source !== 'built-in' ? ` · ${sourceLabel(ins.source)}` : ''}
        </span>
        {isProjectPlugin && props.onOpenFile && (
          <button className="btn sm ghost" onClick={() => props.onOpenFile!(ins.source!.slice(8))} title="Open the plugin code (Claude can change it too)">
            <Code2 size={13} /> code
          </button>
        )}
      </div>
      {ins.doc && <div className="small faint">{ins.doc}</div>}
      {err && (
        <div className="notice warn small">
          <AlertTriangle size={14} /> {err}
        </div>
      )}
      <div className="row wrap" style={{ gap: 10 }}>
        <span className="small faint">octave</span>
        <NumField value={Number(spec.octave ?? ins.octave)} min={-1} max={9} width={48} onChange={(v) => props.onParam(name, 'octave', v, true)} title="octave of notes written without one (e.g. C instead of C4)" />
        <span className="small faint">gate</span>
        <NumField value={spec.gate !== undefined ? Number(spec.gate) : undefined} placeholder={String(ins.gate)} min={0.05} max={1} width={56} onChange={(v) => props.onParam(name, 'gate', v, true)} title="how much of each written note sounds (0.92 default)" />
        {ins.kind === 'sample' && (
          <>
            <span className="small faint">file</span>
            <TextField value={String(spec.file ?? '')} width={180} mono onChange={(v) => props.onParam(name, 'file', v || undefined, true)} />
            <span className="small faint">root</span>
            <TextField value={spec.root !== undefined ? String(spec.root) : ''} width={52} mono placeholder="C4" onChange={(v) => props.onParam(name, 'root', v || undefined, true)} />
          </>
        )}
      </div>
      {kit && (
        <div className="kit-edit">
          <div className="small faint">Kit sounds (row name → instrument, e.g. studio-drums/kick-deep or snare)</div>
          {Object.entries(kit).map(([k, v]) => (
            <div key={k} className="row" style={{ gap: 6 }}>
              <span className="mono small" style={{ width: 70 }}>
                {k}
              </span>
              <TextField mono width={240} value={typeof v === 'string' ? v : JSON.stringify(v)} onChange={(nv) => props.onSpec(name, { ...spec, kit: { ...kit, [k]: nv } })} />
              <button className="btn sm ghost" onClick={() => props.onAudition(name, { k })}>
                ▶
              </button>
              <button
                className="icon-mini"
                title="remove"
                onClick={() => {
                  const n = { ...kit };
                  delete n[k];
                  if (Object.keys(n).length) props.onSpec(name, { ...spec, kit: n });
                }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <button
            className="btn sm ghost"
            onClick={() => {
              const k = window.prompt('Sound name (row name in drum grids)', 'perc');
              if (k && /^[A-Za-z0-9#_.+-]+$/.test(k)) props.onSpec(name, { ...spec, kit: { ...kit, [k]: 'studio-drums/kick-deep' } });
            }}
          >
            <Plus size={13} /> sound
          </button>
        </div>
      )}
      {Object.keys(params).length > 0 && (
        <div className="params">
          {Object.entries(params).map(([k, v]) => (
            <ParamControl
              key={k}
              name={k}
              value={v}
              spec={(specs[k] ?? { type: typeof v === 'number' ? 'number' : 'text', min: 0, max: Math.max(1, Number(v) * 4 || 1) }) as ParamSpec}
              def={voiceDefaults[k]}
              overridden={setIn(k)}
              onChange={(val, done) => props.onParam(name, k, val, done)}
              onReset={() => props.onParam(name, k, undefined, true)}
            />
          ))}
        </div>
      )}
      <div className="audition">
        {ins.drum && ins.sounds?.length ? (
          ins.sounds.slice(0, 24).map((s) => (
            <button key={s} className="pad" onPointerDown={() => props.onAudition(name, { k: s })}>
              {s}
            </button>
          ))
        ) : (
          <div className="mini-keys">
            {Array.from({ length: 25 }, (_, i) => lowest + i).map((p) => (
              <button key={p} className={`mk${isBlackKey(p) ? ' black' : ''}`} onPointerDown={() => props.onAudition(name, { p })} title={midiName(p)}>
                {p % 12 === 0 ? midiName(p) : ''}
              </button>
            ))}
          </div>
        )}
      </div>
      {picking && (
        <SoundPicker
          catalog={props.catalog}
          current={String(spec.use ?? '')}
          onClose={() => setPicking(false)}
          onPick={(c) => {
            setPicking(false);
            props.onSpec(name, specForUse(raw, c));
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Song settings
// ---------------------------------------------------------------------------
export function SongPanel({ model, onSong }: { model: SongModel; onSong: (key: string, value: unknown) => void }) {
  const s = model.song;
  return (
    <div className="song-panel">
      <div className="form-grid">
        <label>Title</label>
        <TextField value={s.title} width={260} onChange={(v) => onSong('title', v || undefined)} />
        <label>Tempo (bpm)</label>
        <NumField value={s.bpm} min={20} max={400} onChange={(v) => v && onSong('bpm', v)} />
        <label>Time signature</label>
        <select className="daw-input" value={s.time} onChange={(e) => onSong('time', e.target.value)} style={{ width: 90 }}>
          {[...new Set([s.time, '4/4', '3/4', '2/4', '5/4', '6/8', '7/8', '9/8', '12/8'])].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <label>Swing</label>
        <div className="row">
          <input type="range" min={0} max={0.5} step={0.01} value={s.swing} onChange={(e) => onSong('swing', Number(e.target.value) || undefined)} />
          <span className="small mono">{s.swing}</span>
          <select className="daw-input" value={s.swingUnit} onChange={(e) => onSong('swing_unit', Number(e.target.value) === 16 ? undefined : Number(e.target.value))} title="which notes swing">
            <option value={16}>16ths</option>
            <option value={8}>8ths</option>
          </select>
        </div>
        <label>Humanize</label>
        <div className="row">
          <input type="range" min={0} max={1} step={0.05} value={s.humanize} onChange={(e) => onSong('humanize', Number(e.target.value) || undefined)} />
          <span className="small mono">{s.humanize}</span>
          <span className="small faint">seed</span>
          <NumField value={s.seed} min={0} max={1e9} width={60} onChange={(v) => onSong('seed', v)} />
        </div>
        <label>Tail (s)</label>
        <NumField value={s.tail} min={0} max={30} onChange={(v) => onSong('tail', v)} />
        <label>Sample rate</label>
        <select className="daw-input" value={s.sampleRate} onChange={(e) => onSong('sample_rate', Number(e.target.value) === 44100 ? undefined : Number(e.target.value))} style={{ width: 100 }}>
          {[44100, 48000, 96000].map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <div className="small faint" style={{ marginTop: 14 }}>
        Humanize and swing are applied in the exact render (Render / Export); the live preview plays swing without humanize.
      </div>
      {model.warnings.length > 0 && (
        <div className="notice warn small" style={{ marginTop: 14, display: 'block' }}>
          <b>Warnings from the engine</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {model.warnings.slice(0, 30).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
