// Song edits: each operation changes the YAML text surgically (yamlEdit) and, where it is cheap to
// do exactly, updates the parsed model right away so the editor reacts without waiting for the engine.
// The engine re-reads the text afterwards and its model replaces the local one.
import { durToken, gridRows, parseDuration, prefersFlats, serializeChords, serializeEvents, serializeGrid, serializeNotes, type NoteEv } from './notation';
import { layoutSections } from './timeline';
import type { DawEvent, DawSection, DawTrack, EffectSpec, PlayEntry, PlayOpts, SongModel, TrackForm } from './types';
import { SongDoc, YamlEditError, type YPath } from './yamlEdit';

export interface EditResult {
  doc: SongDoc;
  /** exact local update, or undefined = wait for the engine */
  model?: SongModel;
}

const clone = <T,>(x: T): T => structuredClone(x);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const EPS = 1e-6;

export function fail(msg: string): never {
  throw new YamlEditError(msg);
}

// ---------------------------------------------------------------------------
// Pattern tracks
// ---------------------------------------------------------------------------
function patternLength(m: SongModel, pattern: string, tracks: Record<string, DawTrack>): number {
  const bars = m.patterns[pattern]?.bars;
  const barLen = m.song.barLen;
  if (bars) return Number(bars) * barLen;
  const raw = Math.max(0, ...Object.values(tracks).map((t) => t.length));
  return Math.max(barLen, Math.ceil(raw / barLen - 1e-9) * barLen);
}

/** The YAML value for a track holding `events` (keeps the written form and options where possible). */
export function trackValue(
  doc: SongDoc,
  m: SongModel,
  pattern: string,
  inst: string,
  events: DawEvent[],
  forceForm?: TrackForm,
  rows?: string[],
): { value: unknown; track: DawTrack } {
  const ins = m.instruments[inst];
  const old = m.patterns[pattern]?.tracks[inst];
  const barLen = m.song.barLen;
  const patLen = m.patterns[pattern]?.length ?? barLen;
  let form: TrackForm = forceForm ?? old?.form ?? (ins?.drum ? 'grid' : 'notes');
  const opts: Record<string, unknown> = { ...(forceForm && forceForm !== old?.form ? {} : (old?.opts ?? {})) };
  const length = Math.max(old?.length ?? 0, barLen);
  const lastEnd = events.reduce((x, e) => Math.max(x, e.t + e.l), 0);
  const newLen = Math.max(length, Math.ceil(lastEnd / barLen - EPS) * barLen);
  const instGate = ins?.gate ?? 0.92;
  const transpose = Number(opts.transpose ?? 0);

  const hasKeys = events.some((e) => e.k !== undefined && e.p === undefined);
  if (hasKeys && form !== 'grid' && form !== 'events') form = 'grid';

  if (form === 'grid') {
    const raw = doc.get(['patterns', pattern, inst]);
    const gridText = typeof raw === 'string' ? raw : isObj(raw) && typeof raw.grid === 'string' ? raw.grid : '';
    const stepTok = String(opts.step ?? 's');
    const step = parseDuration(stepTok, barLen) ?? 0.25;
    const g = serializeGrid(
      events.map((e) => ({ t: e.t, k: e.k ?? (e.p !== undefined ? String(e.p) : undefined), v: e.v })),
      { barLen, step, length: Math.max(old?.length ?? 0, barLen), rows: rows ?? gridRows(gridText) },
    );
    const gate = Number(opts.gate ?? 0.9);
    if (g) {
      const tok = Math.abs(g.step - step) < EPS ? stepTok : durToken(g.step, barLen);
      const o = { ...opts };
      if (tok !== 's' || 'step' in opts) o.step = tok;
      const value = Object.keys(o).length ? { ...o, grid: g.text } : g.text;
      const steps = Math.round(Math.max(old?.length ?? 0, barLen, lastEnd) / g.step);
      return {
        value,
        track: { form: 'grid', opts: o, length: Math.ceil((steps * g.step) / barLen - EPS) * barLen, events: events.map((e) => ({ ...e, l: g.step, d: g.step * gate })) },
      };
    }
    form = 'events';
  }

  if (form === 'events') {
    const o = { ...opts };
    delete o.step;
    delete o.grid;
    const evs = events.map((e) => ({ ...e, p: e.p !== undefined ? e.p - transpose : undefined }));
    return {
      value: { ...o, events: serializeEvents(evs) },
      track: { form: 'events', opts: o, length: lastEnd, events: events.map((e) => ({ ...e, d: e.l * instGate })) },
    };
  }

  const notes: NoteEv[] = events
    .filter((e) => e.p !== undefined)
    .map((e) => ({ t: e.t, l: e.l, p: (e.p as number) - transpose, v: e.v, d: e.d, s: e.s, c: e.c }));

  if (form === 'chords') {
    const octave = Number(opts.octave ?? 3);
    const baseVel = Number(opts.velocity ?? 0.62);
    const text = serializeChords(notes, { barLen, baseVel, voicing: String(opts.voicing ?? 'close'), octave, length: newLen });
    if (text !== null) {
      const gate = Number(opts.gate ?? 0.98);
      return {
        value: { ...opts, chords: text },
        track: { form: 'chords', opts, length: newLen, events: events.map((e) => ({ ...e, d: e.l * gate })) },
      };
    }
    // edited into something that is no chord progression any more → plain notes
    form = 'notes';
    for (const k of ['octave', 'velocity', 'voicing', 'chords']) delete opts[k];
  }

  // notes (string, {notes: …} with options, or a list of voices)
  const baseVel = Number(opts.velocity ?? 0.72);
  const gate = Number(opts.gate ?? instGate);
  const own = JSON.stringify(doc.get(['patterns', pattern, inst]) ?? '');
  const flats = prefersFlats(/[A-G][#b]/.test(own) ? own : doc.text, notes.map((n) => n.p));
  const voices = serializeNotes(notes, { barLen, baseVel, voicing: String(opts.voicing ?? 'close'), length: newLen, gate, flats });
  const o = { ...opts };
  delete o.notes;
  const hasOpts = Object.keys(o).length > 0;
  let value: unknown;
  if (voices.length === 1) value = hasOpts ? { ...o, notes: voices[0] } : voices[0];
  else value = voices.map((v) => (hasOpts ? { ...o, notes: v } : v));
  return {
    value,
    track: {
      form: voices.length > 1 ? 'voices' : 'notes',
      opts: o,
      length: newLen,
      events: events.map((e) => ({ ...e, d: e.d > 0 ? e.d : e.l * (e.s ? 0.5 : gate) })),
    },
  };
}

export function writeTrack(doc: SongDoc, m: SongModel, pattern: string, inst: string, events: DawEvent[], forceForm?: TrackForm, rows?: string[]): EditResult {
  const { value, track } = trackValue(doc, m, pattern, inst, events, forceForm, rows);
  const path = ['patterns', pattern, inst];
  const raw = doc.get(path);
  let nd: SongDoc;
  if (isObj(raw) && isObj(value)) {
    // same shape ({chords: …, octave: 3}): change only what changed, keep key order and formatting
    nd = doc;
    for (const [k, v] of Object.entries(value)) if (JSON.stringify(raw[k]) !== JSON.stringify(v)) nd = nd.set([...path, k], v);
    for (const k of Object.keys(raw)) if (!(k in value)) nd = nd.delete([...path, k]);
  } else nd = doc.set(path, value);
  const nm = clone(m);
  const pat = nm.patterns[pattern] ?? { length: m.song.barLen, tracks: {} };
  pat.tracks[inst] = track;
  pat.length = patternLength(nm, pattern, pat.tracks);
  nm.patterns[pattern] = pat;
  return { doc: nd, model: nm };
}

export function emptyTrackValue(m: SongModel, inst: string, bars = 1): unknown {
  const ins = m.instruments[inst];
  const barLen = m.song.barLen;
  if (ins?.drum) {
    const sounds = ins.sounds?.length ? ins.sounds : ['kick'];
    const row = sounds.includes('kick') ? 'kick' : sounds[0];
    const steps = Math.max(1, Math.round((barLen / 0.25) * bars));
    const cells = Array.from({ length: steps }, (_, i) => (i > 0 && i % 16 === 0 ? '|-' : '-')).join('');
    return `${row}: ${cells}\n`;
  }
  return `r:${durToken(barLen * bars, barLen)}`;
}

export function setTrackText(doc: SongDoc, pattern: string, inst: string, text: string): EditResult {
  return { doc: doc.set(['patterns', pattern, inst], text) };
}

export function setTrackOption(doc: SongDoc, m: SongModel, pattern: string, inst: string, key: string, value: unknown): EditResult {
  const raw = doc.get(['patterns', pattern, inst]);
  const t = m.patterns[pattern]?.tracks[inst];
  if (!t) fail('no such track');
  if (isObj(raw)) return { doc: value === undefined ? doc.delete(['patterns', pattern, inst, key]) : doc.set(['patterns', pattern, inst, key], value) };
  if (value === undefined) return { doc };
  if (typeof raw !== 'string') fail('this track is a list of voices — edit it as text');
  const formKey = t.form === 'grid' ? 'grid' : 'notes';
  return { doc: doc.set(['patterns', pattern, inst], { [key]: value, [formKey]: raw }) };
}

export function addTrack(doc: SongDoc, m: SongModel, pattern: string, inst: string): EditResult {
  if (m.patterns[pattern]?.tracks[inst]) fail(`${inst} already plays in ${pattern}`);
  const bars = Math.max(1, Math.round((m.patterns[pattern]?.length ?? m.song.barLen) / m.song.barLen));
  return { doc: doc.set(['patterns', pattern, inst], emptyTrackValue(m, inst, bars)) };
}

export function removeTrack(doc: SongDoc, m: SongModel, pattern: string, inst: string): EditResult {
  const tracks = Object.keys(m.patterns[pattern]?.tracks ?? {});
  if (tracks.length <= 1) fail('a pattern needs at least one track — delete the pattern instead');
  const nm = clone(m);
  delete nm.patterns[pattern].tracks[inst];
  nm.patterns[pattern].length = patternLength(nm, pattern, nm.patterns[pattern].tracks);
  return { doc: doc.delete(['patterns', pattern, inst]), model: nm };
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------
export function validName(name: string): string {
  const n = name.trim();
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,40}$/.test(n)) fail('use letters, digits, - _ . (max 40)');
  return n;
}

export function addPattern(doc: SongDoc, m: SongModel, name: string, inst: string, bars = 1): EditResult {
  const n = validName(name);
  if (m.patterns[n]) fail(`pattern "${n}" exists`);
  return { doc: doc.set(['patterns', n], { [inst]: emptyTrackValue(m, inst, bars) }, 'block') };
}

function arrangementItems(doc: SongDoc): unknown[] {
  const a = doc.get(['arrangement']);
  return Array.isArray(a) ? a : [];
}

function playList(item: unknown): unknown[] {
  if (!isObj(item)) return [];
  const p = item.play;
  return Array.isArray(p) ? p : p === undefined || p === null ? [] : [p];
}

const playName = (entry: unknown): string => (isObj(entry) ? String(entry.pattern ?? '') : String(entry));

function playItem(p: PlayEntry): unknown {
  return Object.keys(p.opts ?? {}).length ? { pattern: p.pattern, ...p.opts } : p.pattern;
}

/** Make an implicit arrangement (all patterns at once) explicit before editing it. */
export function ensureArrangement(doc: SongDoc, m: SongModel): SongDoc {
  if (!m.implicitArrangement && Array.isArray(doc.get(['arrangement']))) return doc;
  const secs = m.sections.map((s) => ({ section: s.name, bars: s.bars, play: s.play.map(playItem) }));
  return doc.set(['arrangement'], secs, 'block');
}

export function renamePattern(doc: SongDoc, m: SongModel, from: string, to: string): EditResult {
  const n = validName(to);
  if (m.patterns[n]) fail(`pattern "${n}" exists`);
  let d = doc.renameKey(['patterns'], from, n);
  arrangementItems(d).forEach((item, i) => {
    const play = playList(item);
    const raw = isObj(item) ? item.play : undefined;
    if (typeof raw === 'string' && raw === from) {
      d = d.set(['arrangement', i, 'play'], n);
      return;
    }
    play.forEach((e, j) => {
      if (playName(e) !== from) return;
      d = isObj(e) ? d.set(['arrangement', i, 'play', j, 'pattern'], n) : d.set(['arrangement', i, 'play', j], n);
    });
  });
  const nm = clone(m);
  nm.patterns[n] = nm.patterns[from];
  delete nm.patterns[from];
  for (const s of nm.sections) for (const p of s.play) if (p.pattern === from) p.pattern = n;
  return { doc: d, model: nm };
}

export function duplicatePattern(doc: SongDoc, m: SongModel, from: string, to: string): EditResult {
  const n = validName(to);
  if (m.patterns[n]) fail(`pattern "${n}" exists`);
  const value = doc.get(['patterns', from]);
  const nm = clone(m);
  nm.patterns[n] = clone(m.patterns[from]);
  return { doc: doc.set(['patterns', n], value, 'block'), model: nm };
}

export function deletePattern(doc: SongDoc, m: SongModel, name: string): EditResult {
  if (Object.keys(m.patterns).length <= 1) fail('a song needs at least one pattern');
  let d = ensureArrangement(doc, m);
  arrangementItems(d).forEach((item, i) => {
    const play = playList(item);
    if (!play.some((e) => playName(e) === name)) return;
    d = d.set(['arrangement', i, 'play'], play.filter((e) => playName(e) !== name));
  });
  d = d.delete(['patterns', name]);
  const nm = clone(m);
  delete nm.patterns[name];
  for (const s of nm.sections) s.play = s.play.filter((p) => p.pattern !== name);
  nm.implicitArrangement = false;
  return { doc: d, model: nm };
}

export function setPatternBars(doc: SongDoc, m: SongModel, name: string, bars: number | null): EditResult {
  const d = bars ? doc.set(['patterns', name, 'bars'], bars) : doc.delete(['patterns', name, 'bars']);
  const nm = clone(m);
  nm.patterns[name].bars = bars;
  nm.patterns[name].length = patternLength(nm, name, nm.patterns[name].tracks);
  return { doc: d, model: nm };
}

// ---------------------------------------------------------------------------
// Arrangement
// ---------------------------------------------------------------------------
function withSections(m: SongModel, f: (secs: DawSection[]) => DawSection[]): SongModel {
  const nm = clone(m);
  nm.sections = layoutSections(f(nm.sections), nm.song.barLen);
  nm.implicitArrangement = false;
  nm.duration = nm.sections.length ? nm.sections[nm.sections.length - 1].startSec + (nm.sections[nm.sections.length - 1].bars * nm.song.barLen * 60) / nm.sections[nm.sections.length - 1].bpm : 0;
  nm.totalBars = nm.sections.reduce((a, s) => a + s.bars, 0);
  return nm;
}

export function setSectionField(doc: SongDoc, m: SongModel, i: number, field: 'section' | 'bars' | 'bpm' | 'transpose', value: unknown): EditResult {
  let d = ensureArrangement(doc, m);
  const item = arrangementItems(d)[i];
  if (field === 'section' && isObj(item) && !('section' in item) && 'name' in item) d = d.set(['arrangement', i, 'name'], value);
  else d = value === undefined || value === null || value === '' ? d.delete(['arrangement', i, field]) : d.set(['arrangement', i, field], value);
  const model = withSections(m, (secs) => {
    const s = secs[i];
    if (field === 'section') s.name = String(value);
    if (field === 'bars') s.bars = Math.max(0.25, Number(value) || 1);
    if (field === 'bpm') s.bpm = value === undefined || value === null || value === '' ? m.song.bpm : Number(value);
    if (field === 'transpose') s.transpose = Number(value ?? 0) || 0;
    return secs;
  });
  return { doc: d, model };
}

export function addSection(doc: SongDoc, m: SongModel, index: number, sec: { section: string; bars: number; play?: string[] }): EditResult {
  const d = ensureArrangement(doc, m).seqInsert(['arrangement'], index, { section: sec.section, bars: sec.bars, play: sec.play ?? [] });
  const model = withSections(m, (secs) => {
    secs.splice(index, 0, { name: sec.section, bars: sec.bars, bpm: m.song.bpm, transpose: 0, startQ: 0, startSec: 0, play: (sec.play ?? []).map((p) => ({ pattern: p, opts: {} })) });
    return secs;
  });
  return { doc: d, model };
}

export function duplicateSection(doc: SongDoc, m: SongModel, i: number): EditResult {
  const d0 = ensureArrangement(doc, m);
  const item = arrangementItems(d0)[i];
  const d = d0.seqInsert(['arrangement'], i + 1, item);
  const model = withSections(m, (secs) => {
    secs.splice(i + 1, 0, clone(secs[i]));
    return secs;
  });
  return { doc: d, model };
}

export function deleteSection(doc: SongDoc, m: SongModel, i: number): EditResult {
  if (m.sections.length <= 1) fail('a song needs at least one section');
  const d = ensureArrangement(doc, m).seqDelete(['arrangement'], i);
  const model = withSections(m, (secs) => {
    secs.splice(i, 1);
    return secs;
  });
  return { doc: d, model };
}

export function moveSection(doc: SongDoc, m: SongModel, from: number, to: number): EditResult {
  const d = ensureArrangement(doc, m).seqMove(['arrangement'], from, to);
  const model = withSections(m, (secs) => {
    const [x] = secs.splice(from, 1);
    secs.splice(to, 0, x);
    return secs;
  });
  return { doc: d, model };
}

export function togglePlay(doc: SongDoc, m: SongModel, i: number, pattern: string): EditResult {
  const d0 = ensureArrangement(doc, m);
  const item = arrangementItems(d0)[i];
  const play = playList(item);
  const has = play.some((e) => playName(e) === pattern);
  const next = has ? play.filter((e) => playName(e) !== pattern) : [...play, pattern];
  const d = d0.set(['arrangement', i, 'play'], next, 'flow');
  const model = withSections(m, (secs) => {
    const s = secs[i];
    s.play = has ? s.play.filter((p) => p.pattern !== pattern) : [...s.play, { pattern, opts: {} }];
    return secs;
  });
  return { doc: d, model };
}

export function setPlayOpts(doc: SongDoc, m: SongModel, i: number, pattern: string, opts: PlayOpts): EditResult {
  const d0 = ensureArrangement(doc, m);
  const play = playList(arrangementItems(d0)[i]);
  const clean = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)));
  const next = play.map((e) => (playName(e) === pattern ? (Object.keys(clean).length ? { pattern, ...clean } : pattern) : e));
  const d = d0.set(['arrangement', i, 'play'], next, 'flow');
  const model = withSections(m, (secs) => {
    for (const p of secs[i].play) if (p.pattern === pattern) p.opts = clean as PlayOpts;
    return secs;
  });
  return { doc: d, model };
}

// ---------------------------------------------------------------------------
// Song settings
// ---------------------------------------------------------------------------
export function setSongField(doc: SongDoc, m: SongModel, key: string, value: unknown): EditResult {
  const d = value === undefined ? doc.delete(['song', key]) : doc.set(['song', key], value);
  if (['time', 'sample_rate', 'loop'].includes(key)) return { doc: d };
  const nm = clone(m);
  const s = nm.song as unknown as Record<string, unknown>;
  const map: Record<string, string> = { swing_unit: 'swingUnit' };
  s[map[key] ?? key] = value ?? (key === 'swing' || key === 'humanize' ? 0 : s[map[key] ?? key]);
  if (key === 'bpm') {
    const items = arrangementItems(d);
    nm.sections = layoutSections(
      nm.sections.map((sec, i) => (isObj(items[i]) && (items[i] as Record<string, unknown>).bpm !== undefined ? sec : { ...sec, bpm: Number(value) })),
      nm.song.barLen,
    );
  }
  return { doc: d, model: nm };
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------
const RESERVED = new Set(['use', 'params', 'file', 'root', 'pitched', 'kit', 'gain', 'pan', 'effects', 'octave', 'gate', 'volume', 'mute', 'solo', 'reverb', 'delay', 'sustain', 'sounds']);

export function addInstrument(doc: SongDoc, name: string, spec: Record<string, unknown>): EditResult {
  const n = validName(name);
  if (doc.has(['instruments', n])) fail(`instrument "${n}" exists`);
  return { doc: doc.set(['instruments', n], spec, 'flow') };
}

/** Set an instrument parameter (undefined removes it). Handles "bass: bass" shorthands and params: maps. */
export function setInstrumentParam(doc: SongDoc, m: SongModel, name: string, key: string, value: unknown): EditResult {
  const spec = doc.get(['instruments', name]);
  let d: SongDoc;
  if (typeof spec === 'string') {
    if (value === undefined) return { doc };
    d = doc.set(['instruments', name], { use: spec, [key]: value }, 'flow');
  } else if (isObj(spec) && isObj(spec.params) && key in spec.params && !RESERVED.has(key)) {
    d = value === undefined ? doc.delete(['instruments', name, 'params', key]) : doc.set(['instruments', name, 'params', key], value);
  } else {
    d = value === undefined ? doc.delete(['instruments', name, key]) : doc.set(['instruments', name, key], value);
  }
  if (key === 'octave' || key === 'gate' || key === 'use' || key === 'kit' || key === 'file') return { doc: d };
  if (value === undefined) return { doc: d }; // the engine sends the default back with the next model
  const nm = clone(m);
  const ins = nm.instruments[name];
  if (ins?.params && !RESERVED.has(key)) ins.params[key] = value;
  return { doc: d, model: nm };
}

export function setInstrumentSpec(doc: SongDoc, name: string, spec: Record<string, unknown>): EditResult {
  return { doc: doc.set(['instruments', name], spec, 'flow') };
}

function eachEffectList(doc: SongDoc, f: (path: YPath, list: unknown[]) => void): void {
  const mix = doc.get(['mix']);
  if (isObj(mix)) for (const [k, v] of Object.entries(mix)) if (isObj(v) && Array.isArray(v.effects)) f(['mix', k, 'effects'], v.effects);
  const insts = doc.get(['instruments']);
  if (isObj(insts)) for (const [k, v] of Object.entries(insts)) if (isObj(v) && Array.isArray(v.effects)) f(['instruments', k, 'effects'], v.effects);
  const master = doc.get(['master']);
  if (isObj(master) && Array.isArray(master.effects)) f(['master', 'effects'], master.effects);
}

export function renameInstrument(doc: SongDoc, m: SongModel, from: string, to: string): EditResult {
  const n = validName(to);
  if (m.instruments[n]) fail(`instrument "${n}" exists`);
  let d = doc.renameKey(['instruments'], from, n);
  for (const [p, pat] of Object.entries(m.patterns)) if (pat.tracks[from]) d = d.renameKey(['patterns', p], from, n);
  if (d.has(['mix', from])) d = d.renameKey(['mix'], from, n);
  const fixes: [YPath, number][] = [];
  eachEffectList(d, (path, list) =>
    list.forEach((e, i) => {
      if (isObj(e) && e.use === 'sidechain' && e.source === from) fixes.push([path, i]);
    }),
  );
  for (const [path, i] of fixes) d = d.set([...path, i, 'source'], n);
  arrangementItems(d).forEach((item, i) =>
    playList(item).forEach((e, j) => {
      if (!isObj(e) || e.only === undefined) return;
      const only = e.only;
      if (Array.isArray(only) && only.includes(from)) d = d.set(['arrangement', i, 'play', j, 'only'], only.map((x) => (x === from ? n : x)));
      else if (only === from) d = d.set(['arrangement', i, 'play', j, 'only'], n);
    }),
  );
  return { doc: d };
}

export function deleteInstrument(doc: SongDoc, m: SongModel, name: string): EditResult {
  if (Object.keys(m.instruments).length <= 1) fail('a song needs at least one instrument');
  let d = doc;
  let model = m;
  for (const [p, pat] of Object.entries(m.patterns)) {
    if (!pat.tracks[name]) continue;
    if (Object.keys(pat.tracks).length <= 1) {
      if (Object.keys(model.patterns).length <= 1) fail(`"${name}" is the only instrument of the only pattern`);
      const r = deletePattern(d, model, p);
      d = r.doc;
      model = r.model ?? model;
    } else d = d.delete(['patterns', p, name]);
  }
  if (d.has(['mix', name])) d = d.delete(['mix', name]);
  d = d.delete(['instruments', name]);
  return { doc: d };
}

// ---------------------------------------------------------------------------
// Mixer
// ---------------------------------------------------------------------------
function mixPath(doc: SongDoc, inst: string, key: string): YPath {
  const spec = doc.get(['instruments', inst]);
  if (isObj(spec) && key in spec && !doc.has(['mix', inst, key])) return ['instruments', inst, key];
  return ['mix', inst, key];
}

export function setMix(doc: SongDoc, m: SongModel, inst: string, key: string, value: unknown): EditResult {
  const path = mixPath(doc, inst, key);
  let d = value === undefined || value === false ? doc.delete(path) : doc.set(path, value);
  if (path[0] === 'mix' && d.has(['mix', inst]) && JSON.stringify(d.get(['mix', inst])) === '{}') d = d.delete(['mix', inst]);
  const nm = clone(m);
  const mm = (nm.mix[inst] ??= { effects: [] }) as unknown as Record<string, unknown>;
  if (value === undefined || value === false) delete mm[key];
  else mm[key] = value;
  return { doc: d, model: nm };
}

export type FxTarget = { inst: string } | { master: true };

function effectsPath(doc: SongDoc, t: FxTarget): YPath {
  if ('master' in t) return ['master', 'effects'];
  const spec = doc.get(['instruments', t.inst]);
  if (isObj(spec) && Array.isArray(spec.effects) && !doc.has(['mix', t.inst, 'effects'])) return ['instruments', t.inst, 'effects'];
  return ['mix', t.inst, 'effects'];
}

function fxList(m: SongModel, t: FxTarget): EffectSpec[] {
  return 'master' in t ? m.master.effects : (m.mix[t.inst]?.effects ?? []);
}

function withFx(m: SongModel, t: FxTarget, f: (l: EffectSpec[]) => EffectSpec[]): SongModel {
  const nm = clone(m);
  if ('master' in t) nm.master.effects = f(nm.master.effects ?? []);
  else {
    nm.mix[t.inst] ??= { effects: [] };
    nm.mix[t.inst].effects = f(nm.mix[t.inst].effects ?? []);
  }
  return nm;
}

const fxItem = (e: EffectSpec): unknown => (Object.keys(e).length === 1 ? e.use : e);

export function addEffect(doc: SongDoc, m: SongModel, t: FxTarget, fx: EffectSpec): EditResult {
  const list = [...fxList(m, t), fx];
  const d = doc.set(effectsPath(doc, t), list.map(fxItem), 'flow');
  return { doc: d, model: withFx(m, t, () => list) };
}

export function removeEffect(doc: SongDoc, m: SongModel, t: FxTarget, index: number): EditResult {
  const list = fxList(m, t).filter((_, i) => i !== index);
  const path = effectsPath(doc, t);
  const d = list.length ? doc.set(path, list.map(fxItem), 'flow') : doc.delete(path);
  return { doc: d, model: withFx(m, t, () => list) };
}

export function moveEffect(doc: SongDoc, m: SongModel, t: FxTarget, from: number, to: number): EditResult {
  const list = [...fxList(m, t)];
  if (to < 0 || to >= list.length) return { doc };
  const [x] = list.splice(from, 1);
  list.splice(to, 0, x);
  return { doc: doc.set(effectsPath(doc, t), list.map(fxItem), 'flow'), model: withFx(m, t, () => list) };
}

export function setEffectParam(doc: SongDoc, m: SongModel, t: FxTarget, index: number, key: string, value: unknown): EditResult {
  const list = fxList(m, t).map((e, i) => {
    if (i !== index) return e;
    const n = { ...e };
    if (value === undefined) delete n[key];
    else n[key] = value;
    return n;
  });
  const path = effectsPath(doc, t);
  const item = doc.get([...path, index]);
  let d: SongDoc;
  if (isObj(item)) d = value === undefined ? doc.delete([...path, index, key]) : doc.set([...path, index, key], value);
  else d = doc.set([...path, index], fxItem(list[index]));
  return { doc: d, model: withFx(m, t, () => list) };
}

export function setMaster(doc: SongDoc, m: SongModel, key: string, value: unknown): EditResult {
  const d = value === undefined ? doc.delete(['master', key]) : doc.set(['master', key], value);
  const nm = clone(m);
  const mm = nm.master as unknown as Record<string, unknown>;
  if (value === undefined) delete mm[key];
  else mm[key] = value;
  return { doc: d, model: nm };
}
