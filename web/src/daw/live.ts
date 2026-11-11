// Playing an instrument of the song live: notes from a MIDI keyboard, the on-screen keyboard and the
// computer keyboard ("musical typing") all go through one LivePlayer, which sounds them (DawAudio),
// handles the sustain pedal and tells the recorder and the MIDI output what was played.
import type { DawAudio } from './audio';
import type { Catalog, DawInstrument } from './types';

/** The instrument that live input plays. */
export interface LiveTarget {
  inst: string;
  drum: boolean;
  /** drum sounds in pad order (empty for pitched instruments) */
  sounds: string[];
  /** MIDI note → drum sound (General MIDI layout where the kit has those sounds) */
  drumOf: Map<number, string>;
  /** drum sound → MIDI note (for the MIDI output) */
  noteOf: Map<string, number>;
  /** octave of middle C on the keyboards for this instrument (4 = C4) */
  octave: number;
}

export function liveTarget(inst: string, ins: DawInstrument, catalog: Catalog | null): LiveTarget {
  const drumOf = new Map<number, string>();
  const noteOf = new Map<string, number>();
  const sounds = ins.drum ? [...(ins.sounds?.length ? ins.sounds : (catalog?.gmKitRows ?? ['kick', 'snare', 'hat']))] : [];
  if (ins.drum) {
    const gm = catalog?.gmDrums ?? {};
    const rest: string[] = [];
    for (const s of sounds) {
      const n = /^\d{1,3}$/.test(s) ? Number(s) : gm[s];
      if (typeof n === 'number' && n >= 0 && n <= 127 && !drumOf.has(n)) {
        drumOf.set(n, s);
        noteOf.set(s, n);
      } else rest.push(s);
    }
    // sounds General MIDI has no key for: the free keys from C1 (36) upwards
    let free = 36;
    for (const s of rest) {
      while (drumOf.has(free) && free < 127) free++;
      if (free > 127) break;
      drumOf.set(free, s);
      noteOf.set(s, free);
    }
  }
  return { inst, drum: ins.drum, sounds, drumOf, noteOf, octave: Math.max(0, Math.min(8, Math.round(ins.octave ?? 4))) };
}

/** Computer keys that play notes (physical position, so it works on every keyboard layout): semitones above C. */
export const TYPING_KEYS: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
  KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
};
/** Octave down / up and velocity down / up while typing. */
export const TYPING_CONTROL: Record<string, 'oct-' | 'oct+' | 'vel-' | 'vel+'> = { KeyZ: 'oct-', KeyX: 'oct+', KeyC: 'vel-', KeyV: 'vel+' };
const US_LABELS: Record<string, string> = {
  KeyA: 'A', KeyW: 'W', KeyS: 'S', KeyE: 'E', KeyD: 'D', KeyF: 'F', KeyT: 'T', KeyG: 'G', KeyY: 'Y', KeyH: 'H', KeyU: 'U', KeyJ: 'J',
  KeyK: 'K', KeyO: 'O', KeyL: 'L', KeyP: 'P', Semicolon: ';', Quote: "'", KeyZ: 'Z', KeyX: 'X', KeyC: 'C', KeyV: 'V',
};

/** What is printed on those keys on this computer's keyboard layout (US letters when the browser cannot tell). */
export async function typingLabels(): Promise<Record<string, string>> {
  const out = { ...US_LABELS };
  try {
    const kb = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<{ get(code: string): string | undefined }> } }).keyboard;
    const map = await kb?.getLayoutMap?.();
    if (map) for (const code of Object.keys(out)) out[code] = (map.get(code) ?? out[code]).toUpperCase();
  } catch {
    /* not available (Firefox, Safari, embedded frames) */
  }
  return out;
}
export const typingLabelsDefault: Record<string, string> = US_LABELS;

export interface LiveNote {
  /** "n60" for a pitch, "k:snare" for a drum sound */
  id: string;
  p?: number;
  k?: string;
  v: number;
}

interface Held {
  note: LiveNote;
  target: LiveTarget;
  voice: number;
  /** key still down (false = only the pedal holds it) */
  down: boolean;
}

export class LivePlayer {
  target: LiveTarget | null = null;
  /** sustain pedal (MIDI CC 64, or the Sustain button) */
  sustain = false;
  /** a note started / ended (after the pedal let go) */
  onStart?: (n: LiveNote, t: LiveTarget) => void;
  onEnd?: (n: LiveNote, t: LiveTarget) => void;

  private held = new Map<string, Held>();
  private subs = new Set<() => void>();

  constructor(private audio: DawAudio) {}

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }
  private changed(): void {
    for (const fn of this.subs) fn();
  }

  setTarget(t: LiveTarget | null): void {
    if (this.target && (!t || t.inst !== this.target.inst || t.drum !== this.target.drum)) this.panic();
    this.target = t;
    this.changed();
  }

  /** Pitches sounding (keys to light up). */
  notes(): number[] {
    const out: number[] = [];
    for (const h of this.held.values()) if (h.note.p !== undefined) out.push(h.note.p);
    return out;
  }
  /** Drum sounds being hit. */
  keys(): string[] {
    const out: string[] = [];
    for (const h of this.held.values()) if (h.note.k !== undefined) out.push(h.note.k);
    return out;
  }

  private start(note: LiveNote): void {
    const t = this.target;
    if (!t) return;
    const old = this.held.get(note.id);
    if (old) this.finish(note.id, old);
    const voice = this.audio.noteOn(t.inst, note);
    this.held.set(note.id, { note, target: t, voice, down: true });
    this.onStart?.(note, t);
    this.changed();
  }

  private finish(id: string, h: Held): void {
    this.held.delete(id);
    this.audio.noteOff(h.voice);
    this.onEnd?.(h.note, h.target);
  }

  /** A key of a piano keyboard went down (MIDI note number). On a drum kit it hits the sound on that key. */
  pitchOn(note: number, vel: number): void {
    const t = this.target;
    if (!t || note < 0 || note > 127) return;
    const v = Math.min(1, Math.max(0.02, vel));
    if (t.drum) {
      const k = t.drumOf.get(note);
      if (k !== undefined) this.start({ id: `k:${k}`, k, v });
    } else this.start({ id: `n${note}`, p: note, v });
  }

  pitchOff(note: number): void {
    const t = this.target;
    if (!t) return;
    if (t.drum) {
      const k = t.drumOf.get(note);
      if (k !== undefined) this.release(`k:${k}`);
    } else this.release(`n${note}`);
  }

  /** A drum pad went down. */
  drumOn(k: string, vel: number): void {
    if (!this.target?.drum) return;
    this.start({ id: `k:${k}`, k, v: Math.min(1, Math.max(0.02, vel)) });
  }
  drumOff(k: string): void {
    this.release(`k:${k}`);
  }

  private release(id: string): void {
    const h = this.held.get(id);
    if (!h) return;
    if (this.sustain && !h.target.drum) {
      h.down = false;
      return;
    }
    this.finish(id, h);
    this.changed();
  }

  pedal(on: boolean): void {
    if (this.sustain === on) return;
    this.sustain = on;
    if (!on) for (const [id, h] of [...this.held]) if (!h.down) this.finish(id, h);
    this.changed();
  }

  /** End every note now (focus lost, instrument changed, MIDI "all notes off"). */
  panic(): void {
    for (const [id, h] of [...this.held]) this.finish(id, h);
    this.sustain = false;
    this.audio.liveOff();
    this.changed();
  }
}
