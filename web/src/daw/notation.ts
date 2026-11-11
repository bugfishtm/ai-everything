// The song notation of studio-daw, written by the editor. Parsing stays in Python (the engine sends
// parsed events); here we only turn edited events back into readable text the engine reads the same way.
// Keep in sync with tools/studio-daw/studio_daw/notation.py.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const SEMI: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const EPS = 1e-6;

export function midiName(m: number, flats = false): string {
  return `${(flats ? FLAT_NAMES_ALL : NOTE_NAMES)[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}
const FLAT_NAMES_ALL = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Does this text spell accidentals with flats (Eb4, Bb) rather than sharps (D#4, A#)? */
export function prefersFlats(text: string, pitches: number[] = []): boolean {
  const flats = (text.match(/\b[A-G]b(?![a-z])/g) ?? []).length;
  const sharps = (text.match(/\b[A-G]#/g) ?? []).length;
  if (flats !== sharps) return flats > sharps;
  // no hint in the text: Bb/Eb/Ab are more common than A#/D#/G#, F#/C# more common than Gb/Db
  let score = 0;
  for (const p of pitches) {
    const pc = ((p % 12) + 12) % 12;
    if (pc === 10 || pc === 3) score++;
    if (pc === 6 || pc === 1) score--;
  }
  return score > 0;
}

export function isBlackKey(m: number): boolean {
  return [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
}

export function noteToMidi(name: string, defaultOctave = 4): number | null {
  const m = /^([A-Ga-g])([#b]{0,2})(-?\d)?$/.exec(name.trim());
  if (!m) return null;
  const semi = SEMI[m[1].toLowerCase()] + (m[2].split('#').length - 1) - (m[2].split('b').length - 1);
  const o = m[3] !== undefined ? parseInt(m[3], 10) : defaultOctave;
  return 12 * (o + 1) + semi;
}

// ---------------------------------------------------------------------------
// Durations (beats = quarter notes)
// ---------------------------------------------------------------------------
const LETTERS: [string, number][] = [
  ['w', 4],
  ['h', 2],
  ['q', 1],
  ['e', 0.5],
  ['s', 0.25],
  ['t', 0.125],
];
const DUR_TOKENS: [string, number][] = [];
for (const [l, v] of LETTERS) DUR_TOKENS.push([l, v]);
for (const [l, v] of LETTERS) DUR_TOKENS.push([`${l}.`, v * 1.5], [`${l}3`, (v * 2) / 3], [`${l}..`, v * 1.75]);

export function parseDuration(tok: string, barLen = 4): number | null {
  const t = tok.trim();
  const m = /^([whqest])(\.{0,2})(3)?$/.exec(t);
  if (m) {
    const base = Object.fromEntries(LETTERS)[m[1]];
    let val = base;
    let add = base;
    for (let i = 0; i < m[2].length; i++) {
      add /= 2;
      val += add;
    }
    if (m[3]) val *= 2 / 3;
    return val;
  }
  if (t.endsWith('bar') || t.endsWith('bars')) {
    const num = t.replace(/[bars]+$/, '') || '1';
    const n = Number(num);
    return Number.isFinite(n) ? n * barLen : null;
  }
  if (t.includes('/')) {
    const [a, b] = t.split('/', 2).map(Number);
    return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null;
  }
  const v = Number(t);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function durToken(q: number, barLen = 4): string {
  for (const [tok, v] of DUR_TOKENS) if (Math.abs(v - q) < EPS) return tok;
  const bars = q / barLen;
  if (bars >= 2 && Math.abs(bars - Math.round(bars)) < EPS) return `${Math.round(bars)}bar`;
  const r = Math.round(q * 10000) / 10000;
  if (Math.abs(r - q) < EPS) return String(r);
  for (const den of [3, 6, 12, 24, 48, 5, 7, 9]) {
    const num = Math.round(q * den);
    if (num > 0 && Math.abs(num / den - q) < EPS) return `${num}/${den}`;
  }
  return String(Math.round(q * 1e6) / 1e6);
}

/** Grid/snap choices of the editor (beats). */
export const SNAPS: { label: string; value: number }[] = [
  { label: '1 bar', value: -1 },
  { label: '1/2', value: 2 },
  { label: '1/4', value: 1 },
  { label: '1/8', value: 0.5 },
  { label: '1/16', value: 0.25 },
  { label: '1/32', value: 0.125 },
  { label: '1/4 T', value: 2 / 3 },
  { label: '1/8 T', value: 1 / 3 },
  { label: '1/16 T', value: 1 / 6 },
  { label: 'off', value: 0 },
];

// ---------------------------------------------------------------------------
// Dynamics, velocities
// ---------------------------------------------------------------------------
export const DYNAMICS: Record<string, number> = { ppp: 0.2, pp: 0.3, p: 0.45, mp: 0.6, mf: 0.72, f: 0.85, ff: 0.95, fff: 1.0 };

function dynamicFor(v: number): string | null {
  for (const [k, x] of Object.entries(DYNAMICS)) if (Math.abs(x - v) < 1e-4) return k;
  return null;
}

function velSuffix(v: number): string {
  const n = Math.round(v * 127);
  if (n > 1 && Math.abs(n / 127 - v) < 1e-4) return `!${n}`;
  return `!${Math.round(v * 1000) / 1000}`;
}

// ---------------------------------------------------------------------------
// Chords
// ---------------------------------------------------------------------------
export const CHORD_QUALITIES: Record<string, number[]> = {
  '': [0, 4, 7], maj: [0, 4, 7], M: [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7], '-': [0, 3, 7],
  dim: [0, 3, 6], aug: [0, 4, 8], '+': [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7], sus: [0, 5, 7],
  '5': [0, 7], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10], min7: [0, 3, 7, 10], '-7': [0, 3, 7, 10], mmaj7: [0, 3, 7, 11], dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10], '7sus4': [0, 5, 7, 10], '9': [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14],
  add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14], '11': [0, 4, 7, 10, 14, 17], m11: [0, 3, 7, 10, 14, 17],
  '13': [0, 4, 7, 10, 14, 21], '7b9': [0, 4, 7, 10, 13], '7#9': [0, 4, 7, 10, 15], '6/9': [0, 4, 7, 9, 14],
};
/** Qualities tried when naming a stack of notes (most common first). */
const DETECT_ORDER = ['', 'm', '7', 'maj7', 'm7', 'dim', 'aug', 'sus4', 'sus2', '6', 'm6', '9', 'maj9', 'm9', 'add9', 'madd9',
  'dim7', 'm7b5', '7sus4', '11', 'm11', '13', '7b9', '7#9', '6/9', 'mmaj7', '5'];
const CHORD_RE = /^([A-G])([#b]?)([^/@]*)(?:\/([A-G][#b]?))?(?:@(-?\d))?$/;

export function chordNotes(symbol: string, octave = 3, voicing = 'close'): number[] | null {
  const m = CHORD_RE.exec(symbol);
  if (!m || !(m[3] in CHORD_QUALITIES)) return null;
  const [, root, acc, quality, bass, oct] = m;
  const o = oct !== undefined ? parseInt(oct, 10) : octave;
  const base = noteToMidi(`${root}${acc}${o}`);
  if (base === null) return null;
  let notes = CHORD_QUALITIES[quality].map((i) => base + i);
  if ((voicing === 'open' || voicing === 'spread') && notes.length >= 3) notes = notes.map((n, i) => n + (i % 2 === 1 ? 12 : 0));
  else if (voicing === 'drop2' && notes.length >= 4) {
    notes[notes.length - 2] -= 12;
    notes.sort((a, b) => a - b);
  }
  if (bass) {
    let b = noteToMidi(`${bass}${o - 1}`);
    if (b === null) return null;
    while (b >= notes[0]) b -= 12;
    notes.unshift(b);
  }
  return notes;
}

const sameSet = (a: number[], b: number[]) => {
  if (a.length !== b.length) return false;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.every((v, i) => v === y[i]);
};

/** A chord symbol whose notes are exactly `pitches` (e.g. [48,51,55,58] → "Cm7@3"), or null. */
export function detectChord(pitches: number[], voicing = 'close', hint?: string): string | null {
  if (pitches.length < 3) return null;
  if (hint) {
    const n = chordNotes(hint, 3, voicing);
    if (n && sameSet(n, pitches)) return hint;
  }
  const sorted = [...new Set(pitches)].sort((a, b) => a - b);
  if (sorted.length !== pitches.length) return null;
  const tryRoot = (root: number, notes: number[], bassName?: string): string | null => {
    const o = Math.floor(root / 12) - 1;
    for (const q of DETECT_ORDER) {
      for (const names of [FLAT_NAMES, NOTE_NAMES]) {
        const sym = `${names[root % 12]}${q}${bassName ? `/${bassName}` : ''}@${o}`;
        const n = chordNotes(sym, 3, voicing);
        if (n && sameSet(n, notes)) return sym;
      }
    }
    return null;
  };
  for (const r of sorted) {
    const s = tryRoot(r, sorted);
    if (s) return s;
  }
  // slash chord: the lowest note is the bass under a chord
  const bass = sorted[0];
  for (const r of sorted.slice(1)) {
    const s = tryRoot(r, sorted, FLAT_NAMES[bass % 12]);
    if (s) return s;
  }
  return null;
}

export function chordName(sym: string): string {
  return sym.replace(/@-?\d$/, '');
}

// ---------------------------------------------------------------------------
// Writing note lines
// ---------------------------------------------------------------------------
const REST_STEPS = [4, 3, 2, 1.5, 1, 0.75, 0.5, 0.375, 0.25, 0.125];

/** A rest as readable values: 2.25 → [2, 0.25] (h + s) instead of "r:2.25". */
function restParts(len: number, barLen: number): number[] {
  if (DUR_TOKENS.some(([, v]) => Math.abs(v - len) < EPS) || Math.abs(len / barLen - Math.round(len / barLen)) < EPS) return [len];
  const out: number[] = [];
  let left = len;
  for (const s of REST_STEPS) {
    while (left >= s - EPS && out.length < 8) {
      out.push(s);
      left = r6(left - s);
    }
  }
  return left > EPS ? [len] : out;
}
export interface NoteEv {
  t: number;
  l: number;
  p: number;
  v: number;
  /** sounding length (with gate / ties) — lets ties survive a rewrite */
  d?: number;
  s?: 1;
  c?: string;
}

export interface NotesOptions {
  barLen: number;
  /** velocity of notes without a marking (0.72, or the track's `velocity` option) */
  baseVel: number;
  voicing?: string;
  /** pad every voice with rests to at least this many beats (keeps the pattern length) */
  length: number;
  /** bars per line before breaking (multi-line strings become YAML blocks) */
  barsPerLine?: number;
  /** gate of the track: a note sounding longer than length × gate was tied */
  gate?: number;
  /** spell accidentals as flats (Eb) instead of sharps (D#) */
  flats?: boolean;
  lineWidth?: number;
}

interface Slot {
  t: number;
  l: number;
  v: number;
  d?: number;
  s?: 1;
  pitches: number[];
  chord?: string;
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Events → one notation string per voice (overlapping notes need several voices). */
export function serializeNotes(evs: NoteEv[], o: NotesOptions): string[] {
  const groups = new Map<string, Slot>();
  for (const e of evs) {
    if (!(e.l > EPS)) continue;
    const t = r6(Math.max(0, e.t));
    const l = r6(e.l);
    const v = Math.round(e.v * 1e4) / 1e4;
    const d = e.d !== undefined ? Math.round(e.d * 1e4) / 1e4 : undefined;
    const key = `${t}|${l}|${v}|${e.s ?? 0}|${d ?? ''}`;
    const g = groups.get(key);
    if (g) {
      if (!g.pitches.includes(e.p)) g.pitches.push(e.p);
      if (g.chord !== e.c) g.chord = undefined;
    } else groups.set(key, { t, l, v, d, s: e.s, pitches: [e.p], chord: e.c });
  }
  const slots = [...groups.values()].sort((a, b) => a.t - b.t || b.l - a.l || a.pitches[0] - b.pitches[0]);
  const voices: { end: number; slots: Slot[] }[] = [];
  for (const s of slots) {
    s.pitches.sort((a, b) => a - b);
    const v = voices.find((x) => x.end <= s.t + EPS);
    if (v) {
      v.slots.push(s);
      v.end = s.t + s.l;
    } else voices.push({ end: s.t + s.l, slots: [s] });
  }
  if (!voices.length) voices.push({ end: 0, slots: [] });
  return voices.map((v) => writeVoice(v.slots, o));
}

function writeVoice(slots: Slot[], o: NotesOptions): string {
  const bar = o.barLen;
  const gate = o.gate ?? 0.92;
  // segments of each slot: a tied note (sounds longer than written length × gate) is rebuilt as "X:a _:b"
  const segs = slots.map((s) => {
    if (s.d !== undefined && !s.s && gate < 0.999 && s.d > s.l * gate + 1e-3) {
      const f = Math.round(((s.l - s.d) / (1 - gate)) * 1e4) / 1e4;
      if (f > 1e-3 && f < s.l - 1e-3) return [f, r6(s.l - f)];
    }
    return [s.l];
  });
  const crossing = (a: number, b: number) => Math.floor(a / bar + EPS) !== Math.floor(b / bar - EPS);
  // bar lines only when no note crosses one ("F1:2bar Db1:2bar" stays without, like hand-written songs)
  let barLines = true;
  slots.forEach((s, i) => {
    let a = s.t;
    for (const len of segs[i]) {
      if (crossing(a, a + len)) barLines = false;
      a += len;
    }
  });
  const tokens: string[] = [];
  let pos = 0;
  let curDur: number | null = null;
  let curVel = o.baseVel;
  let bars = 0;
  const per = o.barsPerLine ?? 4;
  const atBar = (p: number) => Math.abs(p / bar - Math.round(p / bar)) < EPS && p > EPS;
  const nextBar = (p: number) => (Math.floor(p / bar + EPS) + 1) * bar;
  const dur = (q: number) => {
    if (curDur !== null && Math.abs(q - curDur) < EPS) return '';
    curDur = q;
    return `:${durToken(q, bar)}`;
  };
  const advance = (len: number) => {
    const before = pos;
    pos = r6(pos + len);
    if (!atBar(pos)) return;
    if (barLines) tokens.push('|');
    else {
      const crossed = Math.round(pos / bar) - Math.floor(before / bar + EPS);
      for (let k = 0; k < crossed; k++) if (++bars % per === 0) tokens.push('\n');
    }
  };
  const rest = (to: number) => {
    while (pos < to - EPS) {
      const seg = barLines ? Math.min(to, nextBar(pos)) - pos : to - pos;
      for (const part of restParts(seg, bar)) {
        tokens.push(`r${dur(part)}`);
        advance(part);
      }
    }
  };
  slots.forEach((s, i) => {
    if (s.t > pos + EPS) rest(s.t);
    let suffix = '';
    if (Math.abs(s.v - curVel) > 1e-4) {
      const dyn = dynamicFor(s.v);
      if (dyn) {
        tokens.push(dyn);
        curVel = s.v;
      } else suffix = velSuffix(s.v);
    }
    const sym = s.pitches.length >= 3 ? detectChord(s.pitches, o.voicing ?? 'close', s.chord) : null;
    const body = sym ? `[${sym}]` : s.pitches.map((p) => midiName(p, o.flats)).join('+');
    segs[i].forEach((len, j) => {
      let tok = (j === 0 ? body : '_') + dur(len);
      if (j === 0 && s.s) tok += "'";
      if (j === 0) tok += suffix;
      tokens.push(tok);
      advance(len);
    });
  });
  rest(Math.max(o.length, Math.ceil(pos / bar - EPS) * bar));
  while (tokens.length && (tokens[tokens.length - 1] === '|' || tokens[tokens.length - 1] === '\n')) tokens.pop();
  if (!tokens.length) tokens.push(`r${dur(Math.max(bar, o.length))}`);
  if (!barLines) {
    return tokens
      .join(' ')
      .replace(/ \n /g, '\n')
      .replace(/ \n$/g, '');
  }
  // bars packed into lines of at most ~90 characters
  const barTexts: string[] = [];
  let cur: string[] = [];
  for (const t of tokens) {
    if (t === '|') {
      barTexts.push(cur.join(' '));
      cur = [];
    } else if (t !== '\n') cur.push(t);
  }
  if (cur.length) barTexts.push(cur.join(' '));
  const lines: string[] = [];
  let line = '';
  for (const b of barTexts) {
    if (!line) line = b;
    else if (line.length + b.length + 3 > (o.lineWidth ?? 90)) {
      lines.push(`${line} |`);
      line = b;
    } else line += ` | ${b}`;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Step grids
// ---------------------------------------------------------------------------
const GRID_CHARS: [string, number][] = [
  ['x', 0.8],
  ['X', 1.0],
  ['o', 0.45],
  ['O', 0.6],
  ...Array.from({ length: 9 }, (_, i) => [String(i + 1), (i + 1) / 9] as [string, number]),
];

export function gridChar(v: number): string {
  let best = 'x';
  let bestD = Infinity;
  for (const [c, x] of GRID_CHARS) {
    const d = Math.abs(x - v);
    if (d < bestD - 1e-9) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

export function gridVel(c: string): number {
  return GRID_CHARS.find(([x]) => x === c)?.[1] ?? 0.8;
}

const ROW_NAME = /^[A-Za-z0-9#_.+-]+$/;

/** Row names of a grid text, in order (also rows without hits). */
export function gridRows(text: string): string[] {
  const out: string[] = [];
  for (const ln of String(text).split('\n')) {
    const m = /^\s*([A-Za-z0-9#_.+-]+)\s*:/.exec(ln);
    if (m && !ln.trim().startsWith('#') && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export interface GridOptions {
  barLen: number;
  /** step of the track (`step:` option, default 1/16) in beats */
  step: number;
  /** total length in beats (rows are filled up to it) */
  length: number;
  rows: string[];
}

/** Drum hits → grid text, or null when hits do not fit any step (use the events form then). */
export function serializeGrid(evs: { t: number; k?: string; v: number }[], o: GridOptions): { text: string; step: number } | null {
  const rows = [...o.rows];
  for (const e of evs) if (e.k && !rows.includes(e.k)) rows.push(e.k);
  if (!rows.length || rows.some((r) => !ROW_NAME.test(r))) return null;
  let step = 0;
  for (const div of [1, 2, 3, 4, 6, 8]) {
    const s = o.step / div;
    if (evs.every((e) => Math.abs(e.t / s - Math.round(e.t / s)) < 1e-4)) {
      step = s;
      break;
    }
  }
  if (!step) return null;
  const maxT = evs.reduce((m, e) => Math.max(m, e.t + step), 0);
  const length = Math.max(o.length, Math.ceil(maxT / o.barLen - EPS) * o.barLen, step);
  const steps = Math.max(1, Math.round(length / step));
  const cells = new Map(rows.map((r) => [r, Array(steps).fill('-') as string[]]));
  for (const e of evs) {
    const i = Math.round(e.t / step);
    const row = cells.get(e.k ?? rows[0]);
    if (row && i >= 0 && i < steps) row[i] = gridChar(e.v);
  }
  const perBar = o.barLen / step;
  const group = Number.isInteger(Math.round(perBar * 1e6) / 1e6) && perBar >= 2 ? Math.round(perBar) : 0;
  const width = Math.max(...rows.map((r) => r.length)) + 1;
  const lines = rows.map((r) => {
    const c = cells.get(r)!;
    let s = '';
    for (let i = 0; i < c.length; i++) {
      if (group && i > 0 && i % group === 0) s += '|';
      s += c[i];
    }
    return `${`${r}:`.padEnd(width + 1)}${s}`;
  });
  return { text: `${lines.join('\n')}\n`, step };
}

/** The exact form: [{t, n|k, d, v}] (always works, also for odd timings). */
export function serializeEvents(evs: { t: number; l: number; v: number; p?: number; k?: string }[]): Record<string, unknown>[] {
  return [...evs]
    .sort((a, b) => a.t - b.t)
    .map((e) => {
      const o: Record<string, unknown> = { t: r6(e.t) };
      if (e.p !== undefined) o.n = midiName(e.p);
      else o.k = e.k ?? 'kick';
      o.d = r6(e.l);
      o.v = Math.round(e.v * 1000) / 1000;
      return o;
    });
}

/** Chord track text: "Am7 | F:2 G:2 | C" from chord events (or null if the notes are no chords). */
export function serializeChords(evs: NoteEv[], o: NotesOptions & { octave: number }): string | null {
  const slots = new Map<string, NoteEv[]>();
  for (const e of evs) {
    const k = `${r6(e.t)}|${r6(e.l)}`;
    slots.set(k, [...(slots.get(k) ?? []), e]);
  }
  const list = [...slots.entries()].map(([k, es]) => ({ t: Number(k.split('|')[0]), l: Number(k.split('|')[1]), es })).sort((a, b) => a.t - b.t);
  const bar = o.barLen;
  const items: { t: number; l: number; sym: string }[] = [];
  let end = 0;
  for (const s of list) {
    if (s.t < end - EPS) return null; // overlapping chords
    const pitches = s.es.map((e) => e.p);
    let sym: string | null = null;
    for (const cand of [s.es[0].c, detectChord(pitches, o.voicing ?? 'close')]) {
      if (!cand) continue;
      for (const c of [cand.replace(/@-?\d$/, ''), cand]) {
        const n = chordNotes(c, o.octave, o.voicing ?? 'close');
        if (n && sameSet(n, pitches)) {
          sym = c;
          break;
        }
      }
      if (sym) break;
    }
    if (!sym) return null;
    if (s.es.some((e) => Math.abs(e.v - o.baseVel) > 1e-4)) return null;
    items.push({ t: s.t, l: s.l, sym });
    end = s.t + s.l;
  }
  // bar lines only when no chord crosses one ("Cmaj7:2bar Am9:2bar" stays without)
  const crosses = items.some((it) => Math.floor(it.t / bar + EPS) !== Math.floor((it.t + it.l) / bar - EPS));
  const toks: string[] = [];
  let pos = 0;
  let curDur: number | null = bar; // chord tracks start with one bar per chord
  const dur = (q: number) => {
    if (curDur !== null && Math.abs(q - curDur) < EPS) return '';
    curDur = q;
    return `:${durToken(q, bar)}`;
  };
  const atBar = (p: number) => Math.abs(p / bar - Math.round(p / bar)) < EPS && p > EPS;
  const push = (tok: string, len: number) => {
    toks.push(tok + dur(len));
    pos += len;
    if (!crosses && atBar(pos)) toks.push('|');
  };
  const rest = (to: number) => {
    while (pos < to - EPS) push('r', crosses ? to - pos : Math.min(to, (Math.floor(pos / bar + EPS) + 1) * bar) - pos);
  };
  for (const it of items) {
    rest(it.t);
    push(it.sym, it.l);
  }
  rest(o.length);
  while (toks.length && toks[toks.length - 1] === '|') toks.pop();
  return toks.join(' ');
}
