// Sample banks: single notes rendered by the real studio-daw instruments (built-ins, SoundFonts,
// samples, project/pack plugins — also ones Claude just wrote), fetched once and played in the browser.
import { api, errMsg } from '../api';
import type { TLNote } from './timeline';
import type { DawInstrument, SongModel, SoundsResponse } from './types';

export interface NoteReq {
  id: string;
  p?: number;
  k?: string;
  d: number;
  v: number;
}

export interface Sample {
  buffer: AudioBuffer;
  offset: number;
  dur: number;
  gain: number;
  rate: number;
}

interface Loaded {
  id: string;
  p?: number;
  k?: string;
  d: number;
  v: number;
  buffer: AudioBuffer;
  offset: number;
  dur: number;
  gain: number;
}

const v10 = (v: number) => Math.max(1, Math.min(10, Math.round(v * 10)));
const safe = (s: string) => s.replace(/[^A-Za-z0-9_.#+-]/g, '_').slice(0, 40);

function durBucket(d: number): number {
  const step = d <= 0.5 ? 5 : d <= 2 ? 10 : d <= 8 ? 25 : 100;
  return Math.max(step, Math.ceil((d * 100) / step - 1e-9) * step);
}

/** The cached sound a note needs (velocity in tenths, held time in rounded centiseconds). */
export function noteReq(ins: Pick<DawInstrument, 'drum'>, n: { p?: number; k?: string; v: number; d: number }): NoteReq {
  const vel = v10(n.v);
  if (ins.drum) {
    const key = n.k ?? (n.p !== undefined ? `p${n.p}` : 'hit');
    return { id: `k_${safe(key)}_v${vel}`, k: n.k, p: n.k === undefined ? n.p : undefined, d: 0.25, v: vel / 10 };
  }
  const p = n.p ?? 60;
  const d = durBucket(n.d);
  return { id: `n${p}_d${d}_v${vel}`, p, d: d / 100, v: vel / 10 };
}

export class SoundBank {
  private chunks = new Map<string, Promise<AudioBuffer | null>>();
  private byKey = new Map<string, Map<string, Loaded>>();
  private asked = new Map<string, Set<string>>();
  errors = new Map<string, string>();
  busy = 0;
  onChange?: () => void;

  constructor(
    private projectId: number,
    private ctx: () => BaseAudioContext,
  ) {}

  has(soundKey: string): boolean {
    return (this.byKey.get(soundKey)?.size ?? 0) > 0;
  }

  /** Ask the engine for every sound the song needs that is not loaded or asked for yet. */
  async request(path: string, text: string, model: SongModel, wants: Map<string, NoteReq[]>): Promise<void> {
    const requests: Record<string, NoteReq[]> = {};
    for (const [inst, reqs] of wants) {
      const ins = model.instruments[inst];
      if (!ins) continue;
      const asked = this.asked.get(ins.soundKey) ?? new Set<string>();
      const batch = reqs.filter((r) => !asked.has(r.id)).slice(0, 400);
      if (!batch.length) continue;
      for (const r of batch) asked.add(r.id);
      this.asked.set(ins.soundKey, asked);
      requests[inst] = batch;
    }
    if (!Object.keys(requests).length) return;
    this.busy++;
    this.onChange?.();
    try {
      const r = await api<SoundsResponse>(`/projects/${this.projectId}/daw/sounds`, { body: { path, text, requests } });
      if (!r.ok) throw new Error(r.error || 'rendering sounds failed');
      for (const [inst, msg] of Object.entries(r.errors ?? {})) this.errors.set(inst, msg);
      const loads: Promise<void>[] = [];
      for (const [inst, s] of Object.entries(r.sounds ?? {})) {
        this.errors.delete(inst);
        const map = this.byKey.get(s.soundKey) ?? new Map<string, Loaded>();
        this.byKey.set(s.soundKey, map);
        const askedNow = this.asked.get(s.soundKey) ?? new Set<string>();
        this.asked.set(s.soundKey, askedNow);
        for (const req of requests[inst] ?? []) askedNow.add(req.id);
        for (const [id, e] of Object.entries(s.entries)) {
          const req = (requests[inst] ?? []).find((x) => x.id === id);
          if (!e.f || !req) continue;
          loads.push(
            this.chunk(e.f).then((buffer) => {
              if (!buffer) return;
              map.set(id, { id, p: req.p, k: req.k, d: req.d, v: req.v, buffer, offset: (e.o ?? 0) / r.sr, dur: (e.n ?? 0) / r.sr, gain: e.g ?? 1 });
            }),
          );
        }
      }
      await Promise.all(loads);
    } catch (err) {
      // forget the asks so a later edit retries
      for (const [inst, reqs] of Object.entries(requests)) {
        const ins = model.instruments[inst];
        const asked = ins && this.asked.get(ins.soundKey);
        if (asked) for (const q of reqs) asked.delete(q.id);
        this.errors.set(inst, errMsg(err));
      }
    } finally {
      this.busy--;
      this.onChange?.();
    }
  }

  private chunk(file: string): Promise<AudioBuffer | null> {
    let p = this.chunks.get(file);
    if (!p) {
      p = fetch(`/api/projects/${this.projectId}/daw/cache/${file}`, { credentials: 'same-origin' })
        .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((buf) => this.ctx().decodeAudioData(buf))
        .catch(() => {
          this.chunks.delete(file);
          return null;
        });
      this.chunks.set(file, p);
    }
    return p;
  }

  /**
   * The best loaded sound for a note: exact, else the closest pitch/length/velocity (pitch-shifted).
   * `live`: for held notes of unknown length — a sound that lasts long enough beats a closer pitch.
   */
  lookup(ins: Pick<DawInstrument, 'drum' | 'soundKey'>, n: { p?: number; k?: string; v: number; d: number }, live = false): Sample | null {
    const map = this.byKey.get(ins.soundKey);
    if (!map?.size) return null;
    const want = noteReq(ins, n);
    const exact = map.get(want.id);
    const mk = (s: Loaded, rate: number): Sample => ({
      buffer: s.buffer,
      offset: s.offset,
      dur: s.dur,
      gain: s.gain * Math.pow(Math.max(0.02, n.v) / Math.max(0.05, s.v), 1.5),
      rate,
    });
    if (exact) return mk(exact, 1);
    let best: Loaded | null = null;
    let bestScore = Infinity;
    for (const s of map.values()) {
      let score: number;
      if (ins.drum) {
        if ((s.k ?? '') !== (want.k ?? '') || s.p !== want.p) continue;
        score = Math.abs(s.v - want.v);
      } else {
        if (s.p === undefined || want.p === undefined) continue;
        const dp = Math.abs(s.p - want.p);
        if (dp > 12) continue;
        score = dp * 4 + (s.d + 0.01 < want.d ? (live ? 14 : 3) : 0) + Math.abs(s.v - want.v) * 2 + Math.abs(Math.log((s.d + 0.05) / (want.d + 0.05)));
      }
      if (score < bestScore) {
        best = s;
        bestScore = score;
      }
    }
    if (!best) return null;
    return mk(best, ins.drum || best.p === undefined || want.p === undefined ? 1 : 2 ** ((want.p - best.p) / 12));
  }
}

/** Sounds the timeline needs, per instrument. */
export function wantedSounds(model: SongModel, notes: TLNote[], extra: { inst: string; p?: number; k?: string; v: number; d: number }[] = []): Map<string, NoteReq[]> {
  const out = new Map<string, Map<string, NoteReq>>();
  const add = (inst: string, n: { p?: number; k?: string; v: number; d: number }) => {
    const ins = model.instruments[inst];
    if (!ins) return;
    const r = noteReq(ins, n);
    let m = out.get(inst);
    if (!m) out.set(inst, (m = new Map()));
    if (!m.has(r.id)) m.set(r.id, r);
  };
  for (const n of extra) add(n.inst, n);
  for (const n of notes) add(n.inst, n);
  return new Map([...out].map(([k, v]) => [k, [...v.values()]]));
}
