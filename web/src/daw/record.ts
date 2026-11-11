// Recording: notes played live while the transport runs become events of a pattern track. The
// recorder only collects and times them; the editor writes them into the YAML with the usual
// operations (ops.writeTrack), all of one take as a single undo step.
import type { DawAudio } from './audio';
import type { LiveNote } from './live';
import type { DawEvent, DawTrack, TrackForm } from './types';

/** Where a moment of the song falls inside the pattern being recorded. */
export interface RecLoc {
  /** beats from the pattern start */
  q: number;
  /** length of the pattern (as it loops here) in beats */
  plen: number;
  /** semitones the pattern is transposed by at this place of the song */
  transpose: number;
  bpm: number;
}

export interface RecTake {
  id: number;
  pattern: string;
  inst: string;
  drum: boolean;
  /** input quantize in beats (0 = off) */
  quant: number;
  /** grid step of a drum track in beats */
  step: number;
  /** how much of a written note sounds (track / instrument gate) */
  gate: number;
}

export interface RecNote {
  t: number;
  l: number;
  v: number;
  p?: number;
  k?: string;
}

/** Input quantize choices (beats). */
export const REC_QUANT: { label: string; value: number }[] = [
  { label: 'off', value: 0 },
  { label: '1/4', value: 1 },
  { label: '1/8', value: 0.5 },
  { label: '1/16', value: 0.25 },
  { label: '1/32', value: 0.125 },
  { label: '1/8 T', value: 1 / 3 },
  { label: '1/16 T', value: 1 / 6 },
];

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const r3 = (x: number) => Math.round(x * 1e3) / 1e3;

interface Open {
  note: LiveNote;
  loc: RecLoc;
  /** engine time of the key press (the downbeat when it came during the count-in) */
  at: number;
}

export class Recorder {
  take: RecTake | null = null;
  /** notes written in the current take */
  count = 0;
  /** the take ended by itself because writing failed */
  onAbort?: () => void;
  private open = new Map<string, Open>();
  private done: { note: RecNote; due: number }[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private audio: DawAudio,
    /** pattern position of a song time (seconds), or null where the pattern does not play */
    private locate: (pattern: string, t: number) => RecLoc | null,
    /** write notes into the song; false = it failed (the take ends) */
    private commit: (take: RecTake, notes: RecNote[]) => boolean,
  ) {}

  begin(take: RecTake): void {
    this.end();
    this.take = take;
    this.count = 0;
    this.timer = setInterval(() => this.flush(false), 80);
  }

  /** Finish the take: notes still held end now, everything is written. Returns the number of notes. */
  end(): number {
    if (!this.take) return 0;
    for (const id of [...this.open.keys()]) this.noteOff(id);
    this.flush(true);
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.take = null;
    this.open.clear();
    this.done = [];
    return this.count;
  }

  /** Drop the take without writing what is still pending (the editor closes). */
  cancel(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.take = null;
    this.open.clear();
    this.done = [];
  }

  /** Quantize step in beats for this take (drum grids always snap to something). */
  private grid(take: RecTake): number {
    return take.drum ? take.quant || take.step : take.quant;
  }

  noteOn(n: LiveNote): void {
    const take = this.take;
    if (!take || !this.audio.playing) return;
    if (take.drum ? n.k === undefined : n.p === undefined) return;
    const left = this.audio.countInLeft();
    let loc: RecLoc | null;
    let at = this.audio.now();
    if (left > 0) {
      // during the count-in only a note just before the downbeat counts (it lands on the first beat)
      const g = this.grid(take);
      const start = this.locate(take.pattern, this.audio.position());
      if (!start) return;
      const early = g ? Math.min(0.3, (g * 60) / start.bpm / 2) : 0.1;
      if (left > early) return;
      loc = start;
      at += left;
    } else loc = this.locate(take.pattern, this.audio.position(this.audio.latency()));
    if (!loc) return;
    this.open.set(n.id, { note: n, loc, at });
    if (take.drum) this.noteOff(n.id); // a hit has no length: write it right away
  }

  noteOff(id: string): void {
    const take = this.take;
    const o = this.open.get(id);
    if (!take || !o) return;
    this.open.delete(id);
    const { loc } = o;
    const g = this.grid(take);
    const beatSec = 60 / loc.bpm;
    const held = Math.max(0, (this.audio.now() - o.at) / beatSec);
    // start: on the grid; a note played just before the pattern repeats belongs to its first beat
    let t = g ? Math.round(loc.q / g) * g : r3(loc.q);
    const wait = Math.max(0, t - loc.q) * beatSec;
    let from = loc.q;
    if (t >= loc.plen - 1e-6) {
      t = 0;
      from = loc.q - loc.plen;
    }
    let l: number;
    if (take.drum) l = take.step;
    else {
      const end = from + held;
      l = g ? Math.max(g, Math.round((end - t) / g) * g) : Math.max(0.05, r3(end - t));
      if (t + l > loc.plen + 1e-6) l = Math.max(g || 0.05, loc.plen - t);
    }
    const v = Math.max(1, Math.round(o.note.v * 127)) / 127;
    const note: RecNote = { t: r6(t), l: r6(l), v: Math.round(v * 1e4) / 1e4 };
    if (take.drum) note.k = o.note.k;
    else note.p = Math.min(127, Math.max(0, (o.note.p ?? 60) - loc.transpose));
    // written once the playhead is past its (quantized) start: the running transport never plays it twice
    this.done.push({ note, due: o.at + wait + 0.08 });
  }

  private flush(force: boolean): void {
    const take = this.take;
    if (!take || !this.done.length) return;
    const now = this.audio.now();
    const ready = this.done.filter((d) => force || d.due <= now);
    if (!ready.length) return;
    this.done = this.done.filter((d) => !ready.includes(d));
    if (this.commit(take, ready.map((d) => d.note))) this.count += ready.length;
    else {
      // the song could not be changed (the editor said why): stop recording instead of failing on every note
      this.cancel();
      this.onAbort?.();
    }
  }
}

/** The events of a track with the recorded notes added (a note on the same spot replaces the old one). */
export function mergeTake(track: DawTrack, take: RecTake, notes: RecNote[]): { events: DawEvent[]; form?: TrackForm } {
  if (take.drum) {
    const add: DawEvent[] = notes.filter((n) => n.k !== undefined).map((n) => ({ t: n.t, l: take.step, d: r6(take.step * 0.9), v: n.v, k: n.k }));
    const keep = track.events.filter((e) => !add.some((a) => a.k === e.k && Math.abs(a.t - e.t) < 1e-4));
    return { events: [...keep, ...add] };
  }
  const add: DawEvent[] = notes.filter((n) => n.p !== undefined).map((n) => ({ t: n.t, l: n.l, d: r6(n.l * take.gate), v: n.v, p: n.p }));
  const keep = track.events.filter((e) => e.p !== undefined && !add.some((a) => a.p === e.p && Math.abs(a.t - e.t) < 1e-4));
  // without quantize the timing is free: only the exact events form can hold it readably
  return { events: [...keep, ...add], form: take.quant ? undefined : 'events' };
}
