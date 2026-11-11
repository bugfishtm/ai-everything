// MIDI file → song text. Tracks become instruments (General MIDI SoundFont presets when the
// gm-instruments pack is there, built-in synths otherwise), the song is cut into sections of a few
// bars and repeated parts share one pattern.
import { durToken, serializeEvents, serializeGrid, serializeNotes } from './notation';
import type { Catalog } from './types';
import { formatBlock, formatInline, scalarStr } from './yamlEdit';

interface MidiNote {
  tick: number;
  dur: number;
  note: number;
  vel: number;
  ch: number;
}
interface MidiTrack {
  name: string;
  notes: MidiNote[];
  program: number | null;
  channel: number;
}
export interface MidiFile {
  tpq: number;
  tempo: number;
  meter: [number, number];
  title?: string;
  tracks: MidiTrack[];
}

export function parseMidi(buf: ArrayBuffer): MidiFile {
  const d = new DataView(buf);
  let p = 0;
  const str = (n: number) => {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(p + i));
    p += n;
    return s;
  };
  const u32 = () => {
    const v = d.getUint32(p);
    p += 4;
    return v;
  };
  const u16 = () => {
    const v = d.getUint16(p);
    p += 2;
    return v;
  };
  if (str(4) !== 'MThd') throw new Error('not a MIDI file');
  const hlen = u32();
  const format = u16();
  const ntrks = u16();
  const division = u16();
  p = 8 + hlen;
  if (division & 0x8000) throw new Error('SMPTE timed MIDI files are not supported');
  const tpq = division;
  let tempo = 500000;
  let tempoSet = false;
  let meter: [number, number] = [4, 4];
  let meterSet = false;
  let title: string | undefined;
  const raw: { name: string; notes: MidiNote[]; programs: Map<number, number> }[] = [];
  for (let t = 0; t < ntrks && p < d.byteLength - 8; t++) {
    const id = str(4);
    const len = u32();
    const end = p + len;
    if (id !== 'MTrk') {
      p = end;
      continue;
    }
    let tick = 0;
    let status = 0;
    let name = '';
    const notes: MidiNote[] = [];
    const programs = new Map<number, number>();
    const open = new Map<string, { tick: number; vel: number }[]>();
    const vlq = () => {
      let v = 0;
      for (let i = 0; i < 4; i++) {
        const b = d.getUint8(p++);
        v = (v << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return v;
    };
    while (p < end) {
      tick += vlq();
      let b = d.getUint8(p);
      if (b & 0x80) {
        status = b;
        p++;
      } else b = status;
      const type = status & 0xf0;
      const ch = status & 0x0f;
      if (status === 0xff) {
        const mt = d.getUint8(p++);
        const ml = vlq();
        const at = p;
        if (mt === 0x03) {
          const s = str(ml);
          if (!name) name = s;
          if (t === 0 && !title) title = s;
        } else if (mt === 0x51 && ml === 3 && !tempoSet) {
          tempo = (d.getUint8(at) << 16) | (d.getUint8(at + 1) << 8) | d.getUint8(at + 2);
          tempoSet = true;
        } else if (mt === 0x58 && ml >= 2 && !meterSet) {
          meter = [d.getUint8(at), 2 ** d.getUint8(at + 1)];
          meterSet = true;
        }
        p = at + ml;
        if (mt === 0x2f) break;
      } else if (status === 0xf0 || status === 0xf7) {
        p += vlq();
      } else if (type === 0x90 || type === 0x80) {
        const note = d.getUint8(p++);
        const vel = d.getUint8(p++);
        const key = `${ch}|${note}`;
        if (type === 0x90 && vel > 0) {
          const list = open.get(key) ?? [];
          list.push({ tick, vel });
          open.set(key, list);
        } else {
          const on = open.get(key)?.shift();
          if (on) notes.push({ tick: on.tick, dur: Math.max(1, tick - on.tick), note, vel: on.vel, ch });
        }
      } else if (type === 0xc0) {
        const prog = d.getUint8(p++);
        if (!programs.has(ch)) programs.set(ch, prog);
      } else if (type === 0xd0) p += 1;
      else if (type === 0xa0 || type === 0xb0 || type === 0xe0) p += 2;
      else p++;
    }
    p = end;
    raw.push({ name, notes, programs });
  }
  void format;
  // one track per channel (format 0 files keep everything in one track)
  const tracks: MidiTrack[] = [];
  for (const r of raw) {
    const chans = [...new Set(r.notes.map((n) => n.ch))];
    for (const ch of chans) {
      tracks.push({
        name: chans.length > 1 ? `${r.name || 'ch'}${ch + 1}` : r.name,
        notes: r.notes.filter((n) => n.ch === ch).sort((a, b) => a.tick - b.tick),
        program: r.programs.get(ch) ?? null,
        channel: ch,
      });
    }
  }
  return { tpq, tempo, meter, title, tracks };
}

const SYNTH_BY_FAMILY = ['epiano', 'bell', 'organ', 'pluck', 'bass', 'strings', 'strings', 'lead', 'lead', 'lead', 'lead', 'pad', 'pad', 'pluck', 'bell', 'sine'];

export interface ImportOptions {
  /** beats; 0 = keep (1/48 beat) */
  quantize: number;
  /** bars per section; 0 = one section */
  chunkBars: number;
  useGm: boolean;
}

function slug(s: string, fallback: string): string {
  const x = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
  return /^[a-z_]/.test(x) ? x : x ? `t_${x}` : fallback;
}

export function midiToSong(mf: MidiFile, fileName: string, catalog: Catalog | null, o: ImportOptions): string {
  const bpm = Math.round((60_000_000 / mf.tempo) * 100) / 100;
  const [num, den] = mf.meter;
  const barLen = (num * 4) / den;
  const q = o.quantize || 1 / 48;
  const snap = (x: number) => Math.round(x / q) * q;
  const gmItems = (catalog?.packs ?? []).filter((x) => x.use.startsWith('gm-instruments/'));
  const gmKit = gmItems.find((x) => x.kind === 'drumkit')?.use;
  const drumNames = new Map<number, string>();
  for (const name of [...(catalog?.gmKitRows ?? []), ...Object.keys(catalog?.gmDrums ?? {})]) {
    const n = catalog?.gmDrums?.[name];
    if (n !== undefined && !drumNames.has(n)) drumNames.set(n, name);
  }
  const used = new Set<string>();
  const insts: { name: string; spec: Record<string, unknown>; drum: boolean; notes: { t: number; l: number; p: number; v: number }[] }[] = [];
  for (const [i, tr] of mf.tracks.entries()) {
    if (!tr.notes.length) continue;
    const drum = tr.channel === 9;
    let name = slug(tr.name, drum ? 'drums' : `track${i + 1}`);
    while (used.has(name)) name = `${name}_${i + 1}`;
    used.add(name);
    const prog = tr.program ?? 0;
    let use: string;
    if (drum) use = o.useGm && gmKit ? gmKit : 'drums';
    else if (o.useGm) use = gmItems.find((x) => x.kind === 'instrument' && x.program === prog)?.use ?? SYNTH_BY_FAMILY[Math.floor(prog / 8)];
    else use = SYNTH_BY_FAMILY[Math.floor(prog / 8)];
    const notes = tr.notes.map((n) => {
      const t = snap(n.tick / mf.tpq);
      return { t, l: Math.max(q, snap(n.dur / mf.tpq)), p: n.note, v: n.vel / 127 };
    });
    insts.push({ name, spec: { use }, drum, notes });
  }
  if (!insts.length) throw new Error('the MIDI file has no notes');
  // key of the piece (best matching major scale): flat keys are written with flats (Eb, Ab …)
  const hist = new Array(12).fill(0);
  for (const ins of insts) if (!ins.drum) for (const n of ins.notes) hist[n.p % 12] += n.l;
  let bestKey = 0;
  let bestScore = -1;
  for (let k = 0; k < 12; k++) {
    const score = [0, 2, 4, 5, 7, 9, 11].reduce((a, i) => a + hist[(k + i) % 12], 0);
    if (score > bestScore + 1e-9) {
      bestScore = score;
      bestKey = k;
    }
  }
  const flats = [5, 10, 3, 8, 1, 6].includes(bestKey);
  const endBeat = Math.max(...insts.flatMap((x) => x.notes.map((n) => n.t + n.l)));
  const totalBars = Math.max(1, Math.ceil(endBeat / barLen - 1e-9));
  const chunk = o.chunkBars > 0 ? o.chunkBars : totalBars;
  const nChunks = Math.ceil(totalBars / chunk);
  const patterns: [string, Record<string, unknown>][] = [];
  const sections: { section: string; bars: number; play: string[] }[] = [];
  const bySig = new Map<string, string>();
  const counters = new Map<string, number>();
  for (let c = 0; c < nChunks; c++) {
    const a = c * chunk * barLen;
    const bars = Math.min(chunk, totalBars - c * chunk);
    const b = a + bars * barLen;
    const play: string[] = [];
    for (const ins of insts) {
      const evs = ins.notes.filter((n) => n.t >= a - 1e-9 && n.t < b - 1e-9).map((n) => ({ ...n, t: n.t - a, l: Math.min(n.l, b - n.t) }));
      if (!evs.length) continue;
      let value: unknown;
      if (ins.drum) {
        const rows = [...new Set(evs.map((e) => drumNames.get(e.p) ?? String(e.p)))];
        const g = serializeGrid(
          evs.map((e) => ({ t: e.t, k: drumNames.get(e.p) ?? String(e.p), v: e.v })),
          { barLen, step: 0.25, length: bars * barLen, rows },
        );
        value = g ? (Math.abs(g.step - 0.25) < 1e-9 ? g.text : { step: durToken(g.step, barLen), grid: g.text }) : { events: serializeEvents(evs.map((e) => ({ t: e.t, l: e.l, v: e.v, k: drumNames.get(e.p) ?? String(e.p) }))) };
      } else {
        // the most common velocity becomes the track's base, only deviations are written per note
        const counts = new Map<number, number>();
        for (const e of evs) counts.set(e.v, (counts.get(e.v) ?? 0) + 1);
        const base = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
        const plain = Math.abs(base - 0.72) < 0.004;
        const voices = serializeNotes(plain ? evs.map((e) => (e.v === base ? { ...e, v: 0.72 } : e)) : evs, {
          barLen,
          baseVel: plain ? 0.72 : base,
          length: bars * barLen,
          gate: 0.92,
          flats,
        });
        const vel = Math.round(base * 1e4) / 1e4;
        if (plain) value = voices.length === 1 ? voices[0] : voices;
        else value = voices.length === 1 ? { velocity: vel, notes: voices[0] } : voices.map((v) => ({ velocity: vel, notes: v }));
      }
      const sig = `${ins.name}|${bars}|${JSON.stringify(value)}`;
      let pname = bySig.get(sig);
      if (!pname) {
        const n = (counters.get(ins.name) ?? 0) + 1;
        counters.set(ins.name, n);
        pname = `${ins.name}${n}`;
        bySig.set(sig, pname);
        patterns.push([pname, { [ins.name]: value }]);
      }
      play.push(pname);
    }
    sections.push({ section: `part${c + 1}`, bars, play });
  }
  const lines: string[] = [];
  lines.push(`# Imported from ${fileName} — ${insts.length} instruments, ${totalBars} bars (edit freely; studio-daw docs)`);
  lines.push('song:');
  lines.push(`  title:${formatBlock(mf.title?.trim() || fileName.replace(/\.midi?$/i, ''), 2)}`);
  lines.push(`  bpm: ${bpm}`);
  lines.push(`  time: ${num}/${den}`);
  lines.push('');
  lines.push('instruments:');
  for (const ins of insts) lines.push(`  ${ins.name}: ${formatInline(ins.spec)}`);
  lines.push('');
  lines.push('patterns:');
  for (const [name, value] of patterns) {
    lines.push(`  ${name}:`);
    for (const [k, v] of Object.entries(value)) lines.push(`    ${k}:${formatBlock(v, 4)}`);
  }
  lines.push('');
  lines.push('arrangement:');
  for (const s of sections) lines.push(`  - { section: ${scalarStr(s.section)}, bars: ${s.bars}, play: [${s.play.join(', ')}] }`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}
