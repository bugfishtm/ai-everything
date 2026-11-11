// Song → timed notes, mirroring Song.events() of studio-daw (song.py) without humanize.
import type { DawSection, SongModel } from './types';

export interface TLNote {
  /** start / length in seconds */
  t: number;
  d: number;
  inst: string;
  p?: number;
  k?: string;
  v: number;
  /** section index and pattern of origin (for highlighting) */
  sec: number;
  pattern: string;
}

export function sectionLenSec(s: DawSection, barLen: number): number {
  return (s.bars * barLen * 60) / s.bpm;
}

export function songDuration(m: SongModel): number {
  const last = m.sections[m.sections.length - 1];
  return last ? last.startSec + sectionLenSec(last, m.song.barLen) : 0;
}

/** Recompute start positions after sections changed (bars / bpm). */
export function layoutSections(sections: DawSection[], barLen: number): DawSection[] {
  let q = 0;
  let t = 0;
  return sections.map((s) => {
    const out = { ...s, startQ: q, startSec: t };
    q += s.bars * barLen;
    t += (s.bars * barLen * 60) / s.bpm;
    return out;
  });
}

export function compileTimeline(m: SongModel): TLNote[] {
  const out: TLNote[] = [];
  const barLen = m.song.barLen;
  const unit = m.song.swingUnit === 16 ? 0.25 : 0.5;
  m.sections.forEach((sec, si) => {
    const beat = 60 / sec.bpm;
    const secLen = sec.bars * barLen;
    for (const { pattern, opts } of sec.play) {
      const pat = m.patterns[pattern];
      if (!pat) continue;
      const startBar = Number(opts.offset ?? 0) * barLen;
      const transpose = Number(opts.transpose ?? 0) + (sec.transpose || 0);
      const velScale = Number(opts.velocity ?? 1);
      const only = opts.only === undefined ? null : Array.isArray(opts.only) ? opts.only.map(String) : String(opts.only);
      const plen = opts.bars ? Number(opts.bars) * barLen : pat.length;
      if (!(plen > 0)) continue;
      for (let rep = 0; startBar + rep < secLen - 1e-9; rep += plen) {
        for (const [inst, track] of Object.entries(pat.tracks)) {
          if (only !== null && !(Array.isArray(only) ? only.includes(inst) : only.includes(inst))) continue;
          for (const ev of track.events) {
            if (ev.t >= plen - 1e-9) continue;
            let tq = startBar + rep + ev.t;
            if (tq >= secLen - 1e-9) continue;
            const dq = Math.min(ev.d, secLen - tq);
            const frac = tq % (2 * unit);
            if (m.song.swing && Math.abs(frac - unit) < 1e-6) tq += m.song.swing * unit;
            out.push({
              t: Math.max(0, sec.startSec + tq * beat),
              d: dq * beat,
              inst,
              p: ev.p !== undefined ? ev.p + transpose : undefined,
              k: ev.k,
              v: Math.min(1, Math.max(0.02, ev.v * velScale)),
              sec: si,
              pattern,
            });
          }
        }
      }
    }
  });
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** A song that is just one pattern, played once: what the transport loops in Pattern mode. */
export function patternScope(m: SongModel, name: string): SongModel {
  const barLen = m.song.barLen;
  const host = m.sections.find((s) => s.play.some((p) => p.pattern === name));
  const bpm = host?.bpm ?? m.song.bpm;
  const bars = Math.max(m.patterns[name]?.length ?? barLen, 0.25) / barLen;
  const sec: DawSection = { name, bars, bpm, transpose: 0, startQ: 0, startSec: 0, play: [{ pattern: name, opts: {} }] };
  return { ...m, sections: [sec], implicitArrangement: false, duration: (bars * barLen * 60) / bpm, totalBars: bars };
}

/** Seconds → beats from the song start (follows tempo changes). */
export function secToQ(m: SongModel, t: number): number {
  for (const s of m.sections) {
    const end = s.startSec + sectionLenSec(s, m.song.barLen);
    if (t < end - 1e-9) return s.startQ + (Math.max(0, t - s.startSec) * s.bpm) / 60;
  }
  const last = m.sections[m.sections.length - 1];
  if (!last) return (t * m.song.bpm) / 60;
  return last.startQ + ((t - last.startSec) * last.bpm) / 60;
}

export function qToSec(m: SongModel, q: number): number {
  for (const s of m.sections) {
    if (q < s.startQ + s.bars * m.song.barLen + 1e-9) return s.startSec + ((q - s.startQ) * 60) / s.bpm;
  }
  const last = m.sections[m.sections.length - 1];
  if (!last) return (q * 60) / m.song.bpm;
  return last.startSec + ((q - last.startQ) * 60) / last.bpm;
}

export function formatPos(m: SongModel | null, t: number): string {
  if (!m) return '1.1';
  const q = secToQ(m, Math.max(0, t));
  const beatLen = 4 / m.song.meter[1];
  const bar = Math.floor(q / m.song.barLen + 1e-9);
  const beat = Math.floor((q - bar * m.song.barLen) / beatLen + 1e-9);
  return `${bar + 1}.${beat + 1}`;
}

export function formatTime(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
