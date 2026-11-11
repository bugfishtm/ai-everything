// MIDI devices of the browser (Web MIDI API): keyboards in, synths out. No sysex is asked for.
// Inputs deliver note on/off (with velocity), the sustain pedal and "all notes off"; outputs get the
// notes played live and the notes of one track while the transport runs.

export type MidiStatus = 'unsupported' | 'insecure' | 'off' | 'asking' | 'ready' | 'denied' | 'error';

export interface MidiPortInfo {
  id: string;
  name: string;
}

export type MidiEvent =
  | { type: 'on'; note: number; vel: number; ch: number; /** name of the input it came from */ port: string }
  | { type: 'off'; note: number; ch: number }
  | { type: 'sustain'; on: boolean; ch: number }
  | { type: 'panic' };

const LS_ON = 'daw.midi.on';
const LS_IN = 'daw.midi.in';
const LS_OUT = 'daw.midi.out';

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

interface Queued {
  at: number;
  data: number[];
}

export class MidiIO {
  status: MidiStatus;
  error = '';
  inputs: MidiPortInfo[] = [];
  outputs: MidiPortInfo[] = [];
  /** 'all' = every connected input, 'none' = ignore inputs, else a port id */
  inputId: string = lsGet(LS_IN) ?? 'all';
  /** '' = no output */
  outputId: string = lsGet(LS_OUT) ?? '';
  /** device list, status or selection changed */
  onChange?: () => void;
  onEvent?: (e: MidiEvent) => void;
  /** any message arrived (for the activity light) */
  onActivity?: () => void;

  private access: MIDIAccess | null = null;
  private listening = new Map<string, MIDIInput>();
  private queue: Queued[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  /** notes of the song sounding on the output: "ch|note" → holders and the time of the last note on */
  private sounding = new Map<string, { n: number; at: number }>();
  /** counts dispose() calls, so a permission answer that arrives later is ignored */
  private epoch = 0;
  private readonly handler = (e: MIDIMessageEvent) => this.message(e);

  constructor() {
    if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
      this.status = typeof window !== 'undefined' && window.isSecureContext === false ? 'insecure' : 'unsupported';
    } else this.status = 'off';
  }

  get supported(): boolean {
    return this.status !== 'unsupported' && this.status !== 'insecure';
  }

  /** Why MIDI is not available, in words for the user ('' when it is). */
  get hint(): string {
    switch (this.status) {
      case 'unsupported':
        return 'This browser has no Web MIDI. Chrome, Edge, Opera and Firefox support it.';
      case 'insecure':
        return 'Web MIDI needs a secure page: open the studio over https (or on localhost).';
      case 'denied':
        return 'Access to MIDI devices was denied. Allow "MIDI devices" for this site in the browser (the icon left of the address), then click Connect again.';
      case 'error':
        return `MIDI could not be started: ${this.error}`;
      default:
        return '';
    }
  }

  /** Connect again without a prompt when the user allowed MIDI before. */
  async resume(): Promise<void> {
    if (this.status !== 'off' || lsGet(LS_ON) !== '1') return;
    try {
      const perms = navigator.permissions as Permissions | undefined;
      const st = await perms?.query({ name: 'midi' as PermissionName });
      if (st?.state === 'granted') await this.enable();
    } catch {
      /* the browser does not know the "midi" permission: wait for a click */
    }
  }

  /** Ask the browser for the MIDI devices (shows its permission prompt the first time). */
  async enable(): Promise<void> {
    if (!this.supported || this.status === 'asking' || this.status === 'ready') return;
    this.status = 'asking';
    this.onChange?.();
    const epoch = this.epoch;
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      if (epoch !== this.epoch) return;
      this.access = access;
      access.onstatechange = () => this.refresh();
      this.status = 'ready';
      lsSet(LS_ON, '1');
      this.refresh();
    } catch (err) {
      if (epoch !== this.epoch) return;
      const name = err instanceof Error ? err.name : '';
      this.status = name === 'SecurityError' || name === 'NotAllowedError' ? 'denied' : 'error';
      this.error = err instanceof Error ? err.message : String(err);
      this.onChange?.();
    }
  }

  /** Stop listening and sending (the browser permission stays). */
  disable(): void {
    this.allOff();
    for (const p of this.listening.values()) p.onmidimessage = null;
    this.listening.clear();
    if (this.access) this.access.onstatechange = null;
    this.access = null;
    this.inputs = [];
    this.outputs = [];
    if (this.supported) this.status = 'off';
    lsSet(LS_ON, null);
    this.onChange?.();
  }

  setInput(id: string): void {
    this.inputId = id;
    lsSet(LS_IN, id);
    this.refresh();
  }

  setOutput(id: string): void {
    if (id !== this.outputId) this.allOff();
    this.outputId = id;
    lsSet(LS_OUT, id || null);
    this.onChange?.();
  }

  /** Re-read the device list (called on hot-plug) and listen to the chosen inputs. */
  private refresh(): void {
    const access = this.access;
    if (!access) return;
    const ins: MIDIInput[] = [];
    access.inputs.forEach((p) => {
      if (p.state === 'connected') ins.push(p);
    });
    const outs: MIDIOutput[] = [];
    access.outputs.forEach((p) => {
      if (p.state === 'connected') outs.push(p);
    });
    this.inputs = ins.map((p) => ({ id: p.id, name: p.name || p.manufacturer || 'MIDI input' }));
    this.outputs = outs.map((p) => ({ id: p.id, name: p.name || p.manufacturer || 'MIDI output' }));
    const want = new Map(ins.filter((p) => this.inputId === 'all' || p.id === this.inputId).map((p) => [p.id, p]));
    for (const [id, p] of this.listening) {
      if (want.get(id) === p) continue;
      p.onmidimessage = null;
      this.listening.delete(id);
    }
    for (const [id, p] of want) {
      if (this.listening.has(id)) continue;
      // setting the handler attribute also opens the port (addEventListener would not)
      p.onmidimessage = this.handler;
      this.listening.set(id, p);
    }
    this.onChange?.();
  }

  /** Inputs being listened to right now. */
  get activeInputs(): number {
    return this.listening.size;
  }

  get output(): MIDIOutput | null {
    if (!this.access || !this.outputId) return null;
    const p = this.access.outputs.get(this.outputId);
    return p && p.state === 'connected' ? p : null;
  }

  /** Is the chosen output the device with this (input) name? Then its own notes are not sent back to it. */
  isOutput(name: string): boolean {
    const out = this.output;
    return !!out && !!name && (out.name ?? '') === name;
  }

  private message(e: MIDIMessageEvent): void {
    const d = e.data;
    if (!d || d.length < 1) return;
    const status = d[0];
    if (status >= 0xf0) return; // clock, active sensing, sysex
    this.onActivity?.();
    const type = status & 0xf0;
    const ch = status & 0x0f;
    const a = d.length > 1 ? d[1] : 0;
    const b = d.length > 2 ? d[2] : 0;
    if (type === 0x90 && b > 0) this.onEvent?.({ type: 'on', note: a, vel: b / 127, ch, port: (e.target as MIDIInput | null)?.name ?? '' });
    else if (type === 0x80 || type === 0x90) this.onEvent?.({ type: 'off', note: a, ch });
    else if (type === 0xb0) {
      if (a === 64) this.onEvent?.({ type: 'sustain', on: b >= 64, ch });
      else if (a === 120 || a === 123) this.onEvent?.({ type: 'panic' });
    }
  }

  // ---- output ----------------------------------------------------------------
  private raw(data: number[], at?: number): void {
    const out = this.output;
    if (!out) return;
    try {
      if (at !== undefined && at > performance.now()) out.send(data, at);
      else out.send(data);
    } catch {
      /* the port went away */
    }
  }

  private hold(ch: number, note: number, delta: number, at: number): void {
    const key = `${ch}|${note}`;
    const cur = this.sounding.get(key);
    const n = (cur?.n ?? 0) + delta;
    if (n > 0) this.sounding.set(key, { n, at: delta > 0 ? at : (cur?.at ?? at) });
    else this.sounding.delete(key);
  }

  /** Note on now (live playing). `ch` 0–15, `vel` 0–1. */
  noteOn(note: number, vel: number, ch = 0): void {
    if (note < 0 || note > 127) return;
    this.raw([0x90 | ch, note, Math.max(1, Math.min(127, Math.round(vel * 127)))]);
  }

  noteOff(note: number, ch = 0): void {
    if (note < 0 || note > 127) return;
    this.raw([0x80 | ch, note, 0]);
  }

  /** A note of the running song: on at `at`, off `dur` later (times of performance.now(), ms). */
  schedule(note: number, vel: number, at: number, dur: number, ch = 0): void {
    if (!this.output || note < 0 || note > 127) return;
    const v = Math.max(1, Math.min(127, Math.round(vel * 127)));
    this.queue.push({ at, data: [0x90 | ch, note, v] }, { at: at + Math.max(20, dur), data: [0x80 | ch, note, 0] });
    if (this.timer === undefined) this.timer = setInterval(() => this.pump(), 15);
    this.pump();
  }

  /** Hand the messages of the next moments to the port (with their exact time). */
  private pump(): void {
    const horizon = performance.now() + 60;
    const rest: Queued[] = [];
    for (const q of this.queue) {
      if (q.at > horizon) {
        rest.push(q);
        continue;
      }
      this.raw(q.data, q.at);
      this.hold(q.data[0] & 0x0f, q.data[1], (q.data[0] & 0xf0) === 0x90 ? 1 : -1, q.at);
    }
    this.queue = rest;
    if (!rest.length && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Transport stopped: forget what is queued and end the notes that sound. */
  flush(): void {
    this.queue = [];
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const [key, h] of this.sounding) {
      const [ch, note] = key.split('|').map(Number);
      // a note on that was handed over with a time slightly ahead must be ended after it
      this.raw([0x80 | ch, note, 0], h.at + 1);
    }
    this.sounding.clear();
  }

  /** End everything on the output (also notes this page does not know about). */
  allOff(): void {
    this.flush();
    if (!this.output) return;
    for (let ch = 0; ch < 16; ch++) {
      this.raw([0xb0 | ch, 64, 0]);
      this.raw([0xb0 | ch, 123, 0]);
    }
  }

  dispose(): void {
    this.epoch++;
    this.allOff();
    for (const p of this.listening.values()) p.onmidimessage = null;
    this.listening.clear();
    if (this.access) this.access.onstatechange = null;
    this.access = null;
    this.inputs = [];
    this.outputs = [];
    if (this.supported) this.status = 'off';
    this.onChange = undefined;
    this.onEvent = undefined;
    this.onActivity = undefined;
  }
}
