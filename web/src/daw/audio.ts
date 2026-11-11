// Live playback of the song in the browser: sample banks rendered by the real engine, a lookahead
// scheduler, per-track chains (effects approximated with Web Audio; plugin effects are heard in the
// exact render) and playback of the exact render ("Rendered" mode).
import { SoundBank } from './sounds';
import type { TLNote } from './timeline';
import { songDuration } from './timeline';
import { LIVE_EFFECTS, type EffectSpec, type MixInfo, type SongModel } from './types';

const LOOKAHEAD = 0.25;
const TICK_MS = 25;
/** Held time of the sounds asked for live playing (keyboard, MIDI): long enough to hold a note. */
export const LIVE_HOLD = 4;

/** A note sounding from live input (MIDI keyboard, on-screen keys, computer keyboard) until it is released. */
interface LiveVoice {
  src: AudioScheduledSourceNode;
  gain: GainNode;
  level: number;
  release: number;
  drum: boolean;
}

interface Chain {
  input: GainNode;
  output: AudioNode;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  unsupported: string[];
  sidechain: { source: string; amount: number; release: number } | null;
}

interface Track {
  fxKey: string;
  chain: Chain;
  input: GainNode;
  panL: GainNode;
  panR: GainNode;
  fader: GainNode;
  duck: GainNode;
  gate: GainNode;
  meter: AnalyserNode;
  silent: boolean;
  drum: boolean;
  release: number;
  soundKey: string;
  split: AudioNode;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const dbToAmp = (db: number) => 10 ** (db / 20);

export class DawAudio {
  ctx: AudioContext | null = null;
  bank: SoundBank;
  model: SongModel | null = null;
  timeline: TLNote[] = [];
  tracks = new Map<string, Track>();
  masterMeter: AnalyserNode | null = null;
  masterUnsupported: string[] = [];
  playing = false;
  mode: 'live' | 'rendered' = 'live';
  rendered: AudioBuffer | null = null;
  loop: { a: number; b: number } | null = null;
  loopOn = false;
  metronome = false;
  onStop?: () => void;
  /** Called for every note the transport schedules (ctx time) — used to mirror a track to a MIDI output. */
  onNote?: (n: TLNote, when: number) => void;

  private masterIn!: GainNode;
  private hp!: BiquadFilterNode;
  private masterFx: Chain | null = null;
  private masterFxKey = '';
  private monitor!: GainNode;
  private limiter!: DynamicsCompressorNode;
  private anchorCtx = 0;
  private anchorSong = 0;
  private schedSong = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = new Set<AudioScheduledSourceNode>();
  private renderedSrc: AudioBufferSourceNode | null = null;
  private noise: AudioBuffer | null = null;
  private irCache = new Map<string, AudioBuffer>();
  private volume = 0.8;
  private startCtx = 0;
  private startSong = 0;
  private counting = false;
  private live = new Map<number, LiveVoice>();
  private liveSeq = 0;
  private meterLR: [AnalyserNode, AnalyserNode] | null = null;
  private meterBuf: Float32Array<ArrayBuffer> | null = null;

  constructor(projectId: number) {
    this.bank = new SoundBank(projectId, () => this.ensure());
  }

  ensure(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.masterIn = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 22;
    this.masterIn.connect(hp);
    this.monitor = ctx.createGain();
    this.monitor.gain.value = this.volume;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.08;
    this.masterMeter = ctx.createAnalyser();
    this.masterMeter.fftSize = 512;
    hp.connect(this.monitor);
    this.monitor.connect(this.limiter);
    this.limiter.connect(this.masterMeter);
    this.masterMeter.connect(ctx.destination);
    // left / right meters of the master
    const lr = ctx.createChannelSplitter(2);
    const left = ctx.createAnalyser();
    const right = ctx.createAnalyser();
    left.fftSize = right.fftSize = 512;
    this.limiter.connect(lr);
    lr.connect(left, 0);
    lr.connect(right, 1);
    this.meterLR = [left, right];
    this.hp = hp;
    if (this.model) this.setModel(this.model, this.timeline);
    return ctx;
  }

  async resume(): Promise<void> {
    const ctx = this.ensure();
    if (ctx.state !== 'running') await ctx.resume();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.monitor.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  // ---------------------------------------------------------------------------
  // Model → track chains
  // ---------------------------------------------------------------------------
  setModel(m: SongModel, timeline: TLNote[]): void {
    this.model = m;
    this.timeline = timeline;
    const ctx = this.ctx;
    if (!ctx) return;
    const beat = 60 / m.song.bpm;
    const solos = Object.entries(m.mix).filter(([, x]) => x.solo).map(([k]) => k);
    for (const name of [...this.tracks.keys()]) {
      if (!m.instruments[name]) {
        this.disposeTrack(this.tracks.get(name)!);
        this.tracks.delete(name);
      }
    }
    for (const [name, ins] of Object.entries(m.instruments)) {
      const mix: MixInfo = m.mix[name] ?? { effects: [] };
      const fxList = this.fxListOf(mix);
      const fxKey = JSON.stringify([fxList, m.song.bpm]);
      let tr = this.tracks.get(name);
      if (!tr) {
        const input = ctx.createGain();
        input.channelCount = 2;
        input.channelCountMode = 'explicit';
        input.channelInterpretation = 'speakers';
        const split = ctx.createChannelSplitter(2);
        const merge = ctx.createChannelMerger(2);
        const panL = ctx.createGain();
        const panR = ctx.createGain();
        split.connect(panL, 0);
        split.connect(panR, 1);
        panL.connect(merge, 0, 0);
        panR.connect(merge, 0, 1);
        const fader = ctx.createGain();
        const duck = ctx.createGain();
        const gate = ctx.createGain();
        const meter = ctx.createAnalyser();
        meter.fftSize = 512;
        merge.connect(fader);
        fader.connect(duck);
        duck.connect(gate);
        gate.connect(meter);
        gate.connect(this.masterIn);
        const chain = this.buildChain(fxList, beat);
        input.connect(chain.input);
        chain.output.connect(split);
        tr = { fxKey, chain, input, panL, panR, fader, duck, gate, meter, silent: false, drum: ins.drum, release: ins.release, soundKey: ins.soundKey, split };
        this.tracks.set(name, tr);
      } else if (tr.fxKey !== fxKey) {
        tr.input.disconnect();
        tr.chain.output.disconnect();
        this.disposeChain(tr.chain);
        tr.chain = this.buildChain(fxList, beat);
        tr.input.connect(tr.chain.input);
        tr.chain.output.connect(tr.split);
        tr.fxKey = fxKey;
      }
      tr.drum = ins.drum;
      tr.release = ins.release;
      tr.soundKey = ins.soundKey;
      const ang = ((Math.min(1, Math.max(-1, num(mix.pan, 0))) + 1) * Math.PI) / 4;
      const t = ctx.currentTime;
      tr.panL.gain.setTargetAtTime(Math.cos(ang) * Math.SQRT2, t, 0.01);
      tr.panR.gain.setTargetAtTime(Math.sin(ang) * Math.SQRT2, t, 0.01);
      tr.fader.gain.setTargetAtTime(dbToAmp(num(mix.gain ?? mix.volume, 0)), t, 0.01);
      tr.silent = !!mix.mute || (solos.length > 0 && !solos.includes(name));
      tr.gate.gain.setTargetAtTime(tr.silent ? 0 : 1, t, 0.01);
    }
    // master effects
    const mfx = m.master.effects ?? [];
    const key = JSON.stringify([mfx, m.song.bpm]);
    if (key !== this.masterFxKey) {
      const hp = this.hp;
      hp.disconnect();
      if (this.masterFx) {
        this.masterFx.output.disconnect();
        this.disposeChain(this.masterFx);
      }
      this.masterFx = this.buildChain(mfx, beat);
      hp.connect(this.masterFx.input);
      this.masterFx.output.connect(this.monitor);
      this.masterUnsupported = this.masterFx.unsupported;
      this.masterFxKey = key;
    }
  }

  private fxListOf(mix: MixInfo): EffectSpec[] {
    const list = [...(mix.effects ?? [])];
    if (mix.delay) list.push({ use: 'delay', mix: num(mix.delay, 0) });
    if (mix.reverb) list.push({ use: 'reverb', mix: num(mix.reverb, 0) });
    return list;
  }

  unsupportedOf(inst: string): string[] {
    return this.tracks.get(inst)?.chain.unsupported ?? [];
  }

  private disposeTrack(tr: Track): void {
    tr.input.disconnect();
    tr.gate.disconnect();
    this.disposeChain(tr.chain);
  }

  private disposeChain(c: Chain): void {
    for (const s of c.sources) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    for (const n of c.nodes) n.disconnect();
  }

  // ---------------------------------------------------------------------------
  // Effects (Web Audio approximations of tools/studio-daw/studio_daw/effects.py)
  // ---------------------------------------------------------------------------
  private buildChain(list: EffectSpec[], beat: number): Chain {
    const ctx = this.ctx!;
    const input = ctx.createGain();
    const nodes: AudioNode[] = [input];
    const sources: AudioScheduledSourceNode[] = [];
    const unsupported: string[] = [];
    let sidechain: Chain['sidechain'] = null;
    let cur: AudioNode = input;
    const gain = (v = 1) => {
      const g = ctx.createGain();
      g.gain.value = v;
      nodes.push(g);
      return g;
    };
    const wetDry = (wetNode: AudioNode, wetOut: AudioNode, mix: number, wetGain = 1) => {
      const out = gain();
      const dry = gain(1 - mix);
      const wet = gain(mix * wetGain);
      cur.connect(dry).connect(out);
      cur.connect(wetNode);
      wetOut.connect(wet).connect(out);
      cur = out;
    };
    for (const fx of list) {
      const p = fx as Record<string, unknown>;
      const name = String(fx.use);
      if (!LIVE_EFFECTS.has(name)) {
        unsupported.push(name);
        continue;
      }
      switch (name) {
        case 'gain': {
          const g = gain(dbToAmp(num(p.db, 0)));
          cur.connect(g);
          cur = g;
          break;
        }
        case 'pan':
        case 'width': {
          const split = ctx.createChannelSplitter(2);
          const merge = ctx.createChannelMerger(2);
          nodes.push(split, merge);
          let ll: number, lr: number, rl: number, rr: number;
          if (name === 'pan') {
            const ang = ((Math.min(1, Math.max(-1, num(p.value, 0))) + 1) * Math.PI) / 4;
            ll = Math.cos(ang) * Math.SQRT2;
            rr = Math.sin(ang) * Math.SQRT2;
            lr = rl = 0;
          } else {
            const w = num(p.amount, 1.3);
            ll = rr = (1 + w) / 2;
            lr = rl = (1 - w) / 2;
          }
          cur.connect(split);
          const pairs: [number, number, number][] = [
            [0, 0, ll],
            [1, 0, lr],
            [0, 1, rl],
            [1, 1, rr],
          ];
          for (const [from, to, v] of pairs) {
            if (!v) continue;
            const g = gain(v);
            split.connect(g, from);
            g.connect(merge, 0, to);
          }
          cur = merge;
          break;
        }
        case 'eq': {
          const bands: [BiquadFilterType, number, number, number][] = [
            ['lowshelf', num(p.low_freq, 200), num(p.low, 0), 0.707],
            ['peaking', num(p.mid_freq, 1200), num(p.mid, 0), 0.9],
            ['highshelf', num(p.high_freq, 5000), num(p.high, 0), 0.707],
          ];
          for (const [type, f, g, q] of bands) {
            if (!g) continue;
            const b = ctx.createBiquadFilter();
            b.type = type;
            b.frequency.value = f;
            b.gain.value = g;
            b.Q.value = q;
            nodes.push(b);
            cur.connect(b);
            cur = b;
          }
          break;
        }
        case 'lowpass':
        case 'highpass': {
          const b = ctx.createBiquadFilter();
          b.type = name;
          b.frequency.value = num(p.cutoff, name === 'lowpass' ? 2000 : 120);
          b.Q.value = num(p.q, 0.707);
          nodes.push(b);
          cur.connect(b);
          cur = b;
          break;
        }
        case 'reverb': {
          const conv = ctx.createConvolver();
          conv.normalize = false;
          conv.buffer = this.impulse(num(p.size, 2), num(p.damp, 0.5), num(p.predelay, 0.015));
          nodes.push(conv);
          wetDry(conv, conv, num(p.mix, 0.25), 0.9);
          break;
        }
        case 'delay': {
          const d = ctx.createDelay(10);
          d.delayTime.value = Math.min(9.9, Math.max(0.001, num(p.time, 0.75) * beat));
          const fb = gain(Math.min(0.95, num(p.feedback, 0.35)));
          d.connect(fb).connect(d);
          nodes.push(d);
          wetDry(d, d, num(p.mix, 0.25));
          break;
        }
        case 'chorus': {
          const split = ctx.createChannelSplitter(2);
          const merge = ctx.createChannelMerger(2);
          nodes.push(split, merge);
          const depth = num(p.depth, 0.003);
          const rate = num(p.rate, 0.8);
          for (let ch = 0; ch < 2; ch++) {
            const d = ctx.createDelay(0.1);
            d.delayTime.value = 0.012 + depth / 2;
            const lfo = ctx.createOscillator();
            lfo.frequency.value = rate;
            const amt = gain(depth / 2);
            lfo.connect(amt).connect(d.delayTime);
            lfo.start(ctx.currentTime + (ch ? 1 / (4 * Math.max(rate, 0.01)) : 0));
            sources.push(lfo);
            nodes.push(d, lfo);
            split.connect(d, ch);
            d.connect(merge, 0, ch);
          }
          wetDry(split, merge, num(p.mix, 0.4));
          break;
        }
        case 'distortion': {
          const ws = ctx.createWaveShaper();
          const drive = Math.max(0.01, num(p.drive, 2.5));
          const curve = new Float32Array(2048);
          for (let i = 0; i < curve.length; i++) {
            const x = (i / (curve.length - 1)) * 2 - 1;
            curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
          }
          ws.curve = curve;
          ws.oversample = '2x';
          nodes.push(ws);
          wetDry(ws, ws, num(p.mix, 1));
          break;
        }
        case 'saturate': {
          // close to the engine: soft clipping that keeps the level, then a tone filter
          const ws = ctx.createWaveShaper();
          const drive = Math.max(0.1, num(p.drive, 1.5));
          const curve = new Float32Array(2048);
          for (let i = 0; i < curve.length; i++) {
            const x = (i / (curve.length - 1)) * 2 - 1;
            curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
          }
          ws.curve = curve;
          ws.oversample = '2x';
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.value = Math.min(20000, 2500 * 2 ** (Math.min(1, Math.max(0, num(p.tone, 0.5))) * 3));
          ws.connect(lp);
          nodes.push(ws, lp);
          wetDry(ws, lp, num(p.mix, 1), 1 / Math.max(1, Math.sqrt(drive)));
          break;
        }
        case 'autopan': {
          const pan = ctx.createStereoPanner();
          const lfo = ctx.createOscillator();
          lfo.frequency.value = 1 / Math.max(0.05, num(p.beats, 2) * beat);
          const amt = gain(Math.min(1, Math.max(0, num(p.depth, 0.8))));
          lfo.connect(amt).connect(pan.pan);
          lfo.start();
          sources.push(lfo);
          nodes.push(lfo, pan);
          cur.connect(pan);
          cur = pan;
          break;
        }
        case 'bitcrush': {
          const ws = ctx.createWaveShaper();
          const q = 2 ** (Math.max(1, num(p.bits, 8)) - 1);
          const curve = new Float32Array(4096);
          for (let i = 0; i < curve.length; i++) {
            const x = (i / (curve.length - 1)) * 2 - 1;
            curve[i] = Math.round(x * q) / q;
          }
          ws.curve = curve;
          nodes.push(ws);
          cur.connect(ws);
          cur = ws;
          break;
        }
        case 'compressor':
        case 'limiter': {
          const c = ctx.createDynamicsCompressor();
          if (name === 'compressor') {
            c.threshold.value = Math.max(-100, Math.min(0, num(p.threshold, -18)));
            c.ratio.value = Math.max(1, Math.min(20, num(p.ratio, 3)));
            c.attack.value = Math.max(0, Math.min(1, num(p.attack, 0.01)));
            c.release.value = Math.max(0, Math.min(1, num(p.release, 0.12)));
          } else {
            c.threshold.value = Math.max(-100, Math.min(0, num(p.ceiling, -1)));
            c.ratio.value = 20;
            c.attack.value = 0.001;
            c.release.value = 0.06;
          }
          c.knee.value = 0;
          nodes.push(c);
          cur.connect(c);
          cur = c;
          if (name === 'compressor' && num(p.makeup, 0)) {
            const g = gain(dbToAmp(num(p.makeup, 0)));
            cur.connect(g);
            cur = g;
          }
          break;
        }
        case 'tremolo': {
          const depth = Math.min(1, Math.max(0, num(p.depth, 0.5)));
          const g = gain(1 - depth / 2);
          const lfo = ctx.createOscillator();
          lfo.frequency.value = num(p.rate, 5);
          const amt = gain(depth / 2);
          lfo.connect(amt).connect(g.gain);
          lfo.start();
          sources.push(lfo);
          nodes.push(lfo);
          cur.connect(g);
          cur = g;
          break;
        }
        case 'sidechain':
          sidechain = { source: String(p.source ?? 'kick'), amount: Math.min(1, Math.max(0, num(p.amount, 0.6))), release: Math.max(0.01, num(p.release, 0.18)) };
          break;
        default: // fade: whole-render effect, nothing to do live
          break;
      }
    }
    return { input, output: cur, nodes, sources, unsupported, sidechain };
  }

  private impulse(size: number, damp: number, predelay: number): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const key = `${size}|${damp}|${predelay}|${sr}`;
    const hit = this.irCache.get(key);
    if (hit) return hit;
    const n = Math.max(64, Math.floor(size * sr));
    const pre = Math.max(0, Math.floor(predelay * sr));
    const buf = ctx.createBuffer(2, n + pre, sr);
    const cutoff = 1800 + 4000 * (1 - damp);
    const a = Math.exp((-2 * Math.PI * cutoff) / sr);
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 4294967296) * 2 - 1;
    };
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      let energy = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const x = rnd();
        lp = (1 - a) * x + a * lp;
        const v = (x * (1 - t * damp) + lp * 2.5 * (t * damp)) * Math.exp((-6.9 * i) / (sr * Math.max(size, 1e-3)));
        d[pre + i] = v;
        energy += v * v;
      }
      const norm = 1 / (Math.sqrt(energy) + 1e-9);
      for (let i = pre; i < n + pre; i++) d[i] *= norm;
    }
    this.irCache.set(key, buf);
    return buf;
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------
  get duration(): number {
    if (this.mode === 'rendered' && this.rendered) return this.rendered.duration;
    return this.model ? songDuration(this.model) + (this.model.song.tail ?? 0) : 0;
  }

  /** Song position in seconds; `ago` looks that many seconds back (what was heard when a key was hit). */
  position(ago = 0): number {
    if (!this.playing || !this.ctx) return this.anchorSong;
    const now = this.ctx.currentTime - ago;
    if (now <= this.startCtx) return this.startSong; // count-in, or the moment before the first note
    let p = this.anchorSong + (now - this.anchorCtx);
    if (this.loopOn && this.loop && p < this.loop.a) p = this.loop.b - (this.loop.a - p);
    return Math.max(0, p);
  }

  /** Seconds of count-in left before the transport moves (0 = running or stopped). */
  countInLeft(): number {
    if (!this.playing || !this.counting || !this.ctx) return 0;
    return Math.max(0, this.startCtx - this.ctx.currentTime);
  }

  /** The clock of the audio engine in seconds (0 before the first sound). */
  now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Seconds between scheduling a sound and hearing it (output latency of the device). */
  latency(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const out = (ctx as AudioContext & { outputLatency?: number }).outputLatency;
    return Math.min(0.3, (Number.isFinite(out) ? (out as number) : 0) + (Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0));
  }

  /** Tempo at a song position: seconds per beat of the meter and beats per bar. */
  private meterAt(t: number): { beatSec: number; beats: number } {
    const m = this.model;
    if (!m) return { beatSec: 0.5, beats: 4 };
    const beatQ = 4 / m.song.meter[1];
    let bpm = m.song.bpm;
    for (const s of m.sections) if (t >= s.startSec - 1e-9) bpm = s.bpm;
    return { beatSec: (beatQ * 60) / bpm, beats: Math.max(1, Math.round(m.song.barLen / beatQ)) };
  }

  /** Start the transport at `from`; `countInBars` clicks that many bars first (live mode). */
  async play(from: number, countInBars = 0): Promise<void> {
    await this.resume();
    this.stopSources();
    const ctx = this.ctx!;
    this.playing = true;
    let lead = 0.06;
    this.counting = false;
    if (countInBars > 0 && !(this.mode === 'rendered' && this.rendered)) {
      const { beatSec, beats } = this.meterAt(Math.max(0, from));
      const n = Math.round(countInBars * beats);
      for (let i = 0; i < n; i++) this.click(ctx.currentTime + lead + i * beatSec, i % beats === 0);
      lead += n * beatSec;
      this.counting = true;
    }
    this.anchorCtx = ctx.currentTime + lead;
    this.anchorSong = Math.max(0, from);
    this.startCtx = this.anchorCtx;
    this.startSong = this.anchorSong;
    this.schedSong = this.anchorSong;
    if (this.mode === 'rendered' && this.rendered) {
      const src = ctx.createBufferSource();
      src.buffer = this.rendered;
      src.connect(this.monitor);
      if (this.loopOn && this.loop) {
        src.loop = true;
        src.loopStart = this.loop.a;
        src.loopEnd = Math.min(this.loop.b, this.rendered.duration);
      } else {
        src.onended = () => {
          if (this.renderedSrc === src) this.finish();
        };
      }
      src.start(this.anchorCtx, Math.min(this.anchorSong, this.rendered.duration));
      this.renderedSrc = src;
      this.timer = setInterval(() => this.tickRendered(), 100);
      return;
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    const pos = this.position();
    this.stopSources();
    this.playing = false;
    this.anchorSong = pos;
  }

  seek(t: number): void {
    if (this.playing) void this.play(t);
    else this.anchorSong = Math.max(0, t);
  }

  private finish(): void {
    this.stopSources();
    this.playing = false;
    this.anchorSong = 0;
    this.onStop?.();
  }

  private stopSources(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const now = this.ctx?.currentTime ?? 0;
    for (const s of this.active) {
      try {
        s.stop(now + 0.01);
      } catch {
        /* already stopped */
      }
    }
    this.active.clear();
    if (this.renderedSrc) {
      try {
        this.renderedSrc.stop();
      } catch {
        /* */
      }
      this.renderedSrc = null;
    }
    for (const tr of this.tracks.values()) {
      tr.duck.gain.cancelScheduledValues(0);
      tr.duck.gain.value = 1;
    }
  }

  private tickRendered(): void {
    if (!this.rendered || !this.ctx) return;
    if (!(this.loopOn && this.loop) && this.position() > this.rendered.duration + 0.1) this.finish();
  }

  private tick(): void {
    const ctx = this.ctx;
    if (!ctx || !this.model) return;
    const end = songDuration(this.model);
    let target = this.anchorSong + (ctx.currentTime + LOOKAHEAD - this.anchorCtx);
    let guard = 0;
    while (this.schedSong < target - 1e-6 && guard++ < 8) {
      const loop = this.loopOn && this.loop && this.loop.b > this.loop.a + 0.05 ? this.loop : null;
      const segEnd = Math.min(target, loop ? loop.b : end);
      this.scheduleRange(this.schedSong, segEnd);
      this.schedSong = segEnd;
      if (loop && this.schedSong >= loop.b - 1e-6) {
        this.anchorCtx += loop.b - this.anchorSong;
        this.anchorSong = loop.a;
        this.schedSong = loop.a;
        target = this.anchorSong + (ctx.currentTime + LOOKAHEAD - this.anchorCtx);
      } else if (!loop && this.schedSong >= end - 1e-6) {
        const tail = (this.model.song.tail ?? 2) + 0.2;
        if (ctx.currentTime > this.anchorCtx + (end - this.anchorSong) + tail) this.finish();
        break;
      }
    }
  }

  private scheduleRange(a: number, b: number): void {
    const tl = this.timeline;
    let lo = 0;
    let hi = tl.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tl[mid].t < a - 1e-9) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < tl.length && tl[i].t < b - 1e-9; i++) {
      const n = tl[i];
      const when = this.anchorCtx + (n.t - this.anchorSong);
      this.playNote(n.inst, n, when);
      this.onNote?.(n, when);
    }
    if (this.metronome && this.model) this.clicks(a, b);
  }

  private clicks(a: number, b: number): void {
    const m = this.model!;
    const beatQ = 4 / m.song.meter[1];
    for (const s of m.sections) {
      const len = (s.bars * m.song.barLen * 60) / s.bpm;
      if (s.startSec >= b || s.startSec + len <= a) continue;
      const step = (beatQ * 60) / s.bpm;
      const first = Math.max(0, Math.ceil((a - s.startSec) / step - 1e-9));
      for (let k = first; s.startSec + k * step < Math.min(b, s.startSec + len) - 1e-9; k++) {
        const t = s.startSec + k * step;
        const beatInBar = Math.round(((k * beatQ) % m.song.barLen) / beatQ);
        this.click(this.anchorCtx + (t - this.anchorSong), beatInBar === 0);
      }
    }
  }

  private click(when: number, accent: boolean): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = accent ? 1760 : 1320;
    g.gain.setValueAtTime(0.25, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
    o.connect(g).connect(this.monitor);
    o.start(when);
    o.stop(when + 0.06);
    this.track(o, g);
  }

  private track(src: AudioScheduledSourceNode, ...nodes: AudioNode[]): void {
    this.active.add(src);
    src.onended = () => {
      this.active.delete(src);
      for (const n of nodes) n.disconnect();
    };
  }

  /** Play one note now (preview while editing); also asks for the exact sound in the background. */
  async audition(inst: string, n: { p?: number; k?: string; v: number; d: number }): Promise<void> {
    await this.resume();
    this.playNote(inst, n, this.ctx!.currentTime + 0.01, true);
  }

  // ---------------------------------------------------------------------------
  // Live playing (MIDI keyboard, on-screen keys, computer keyboard)
  // ---------------------------------------------------------------------------
  /** Start a note that sounds until noteOff (drums: one shot). Returns a handle, 0 = nothing started. */
  noteOn(inst: string, n: { p?: number; k?: string; v: number }): number {
    const ctx = this.ensure();
    if (ctx.state !== 'running') void ctx.resume();
    const tr = this.tracks.get(inst);
    if (!tr) return 0;
    const when = ctx.currentTime;
    const v = Math.min(1, Math.max(0.02, n.v));
    const g = ctx.createGain();
    g.connect(tr.silent ? this.masterIn : tr.input);
    const s = this.bank.lookup({ drum: tr.drum, soundKey: tr.soundKey }, { p: n.p, k: n.k, v, d: LIVE_HOLD }, true);
    let src: AudioScheduledSourceNode;
    let level: number;
    const extra: AudioNode[] = [];
    if (s) {
      const b = ctx.createBufferSource();
      b.buffer = s.buffer;
      b.playbackRate.value = s.rate;
      level = s.gain;
      g.gain.value = level;
      b.connect(g);
      b.start(when, s.offset, s.dur);
      src = b;
    } else if (tr.drum) {
      // stand-in until the engine has rendered the kit: a short noise / sine hit
      const key = (n.k ?? '').toLowerCase();
      level = 0.25 * Math.pow(v, 1.5);
      if (/kick|bd|boom|impact/.test(key)) {
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(150, when);
        o.frequency.exponentialRampToValueAtTime(45, when + 0.12);
        g.gain.setValueAtTime(level * 2.4, when);
        g.gain.exponentialRampToValueAtTime(0.001, when + 0.35);
        o.connect(g);
        o.start(when);
        o.stop(when + 0.4);
        src = o;
      } else {
        const b = ctx.createBufferSource();
        b.buffer = this.noiseBuffer();
        const f = ctx.createBiquadFilter();
        const hat = /hat|hh|ride|crash|cym|shaker|tamb|splash|china/.test(key);
        f.type = hat ? 'highpass' : 'bandpass';
        f.frequency.value = hat ? 7000 : 1800;
        const len = /crash|ride|ohat|open|china/.test(key) ? 0.6 : hat ? 0.06 : 0.16;
        g.gain.setValueAtTime(level * 1.6, when);
        g.gain.exponentialRampToValueAtTime(0.001, when + len);
        b.connect(f).connect(g);
        b.start(when, Math.random() * 0.5, len + 0.05);
        extra.push(f);
        src = b;
      }
    } else {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 440 * 2 ** (((n.p ?? 60) - 69) / 12);
      level = 0.25 * Math.pow(v, 1.5);
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(level, when + 0.008);
      o.connect(g);
      o.start(when);
      src = o;
    }
    const id = ++this.liveSeq;
    this.live.set(id, { src, gain: g, level, release: Math.max(0.03, Math.min(2, tr.release)), drum: tr.drum });
    src.onended = () => {
      this.live.delete(id);
      g.disconnect();
      for (const x of extra) x.disconnect();
    };
    // sidechain: live notes duck the tracks keyed by this one, like played ones
    for (const other of this.tracks.values()) {
      const sc = other.chain.sidechain;
      if (!sc || sc.source !== inst) continue;
      const depth = sc.amount * Math.min(1, v / 0.8);
      other.duck.gain.setTargetAtTime(1 - depth, when, 0.004);
      other.duck.gain.setTargetAtTime(1, when + 0.03, sc.release / 3);
    }
    return id;
  }

  /** Release a live note (fades with the instrument's release; drums ring out). */
  noteOff(id: number): void {
    const v = this.live.get(id);
    const ctx = this.ctx;
    if (!v || !ctx || v.drum) return;
    this.live.delete(id);
    const t = ctx.currentTime;
    const g = v.gain.gain;
    try {
      g.cancelScheduledValues(t);
      g.setValueAtTime(Math.min(v.level, Math.max(0, g.value)), t);
      g.setTargetAtTime(0, t, v.release / 4);
      v.src.stop(t + v.release * 1.5 + 0.05);
    } catch {
      /* already ended */
    }
  }

  /** Silence every live note at once (panic, closing the editor). */
  liveOff(): void {
    const t = this.ctx?.currentTime ?? 0;
    for (const v of this.live.values()) {
      try {
        v.gain.gain.cancelScheduledValues(t);
        v.gain.gain.setTargetAtTime(0, t, 0.01);
        v.src.stop(t + 0.08);
      } catch {
        /* already ended */
      }
    }
    this.live.clear();
  }

  private playNote(inst: string, n: { p?: number; k?: string; v: number; d: number }, when: number, force = false): void {
    const tr = this.tracks.get(inst);
    const ctx = this.ctx;
    if (!tr || !ctx || (tr.silent && !force)) return;
    const g = ctx.createGain();
    g.connect(force && tr.silent ? this.masterIn : tr.input);
    const s = this.bank.lookup({ drum: tr.drum, soundKey: tr.soundKey }, n);
    if (s) {
      const b = ctx.createBufferSource();
      b.buffer = s.buffer;
      b.playbackRate.value = s.rate;
      g.gain.value = s.gain;
      const sliceReal = s.dur / s.rate;
      if (tr.drum) b.start(when, s.offset, s.dur);
      else {
        const rel = Math.max(0.02, tr.release);
        const playLen = Math.min(sliceReal, n.d + rel + 0.05);
        b.start(when, s.offset, playLen * s.rate);
        if (playLen > n.d + 0.005) {
          g.gain.setValueAtTime(s.gain, when + n.d);
          g.gain.setTargetAtTime(0, when + n.d, rel / 4);
        }
      }
      b.connect(g);
      this.track(b, g);
    } else this.fallback(tr, n, when, g);
    // sidechain: duck the tracks keyed by this one
    for (const other of this.tracks.values()) {
      const sc = other.chain.sidechain;
      if (!sc || sc.source !== inst) continue;
      const depth = sc.amount * Math.min(1, n.v / 0.8);
      other.duck.gain.setTargetAtTime(1 - depth, when, 0.004);
      other.duck.gain.setTargetAtTime(1, when + 0.03, sc.release / 3);
    }
  }

  /** Simple stand-in sound while the real one is still rendering. */
  private fallback(tr: Track, n: { p?: number; k?: string; v: number; d: number }, when: number, out: GainNode): void {
    const ctx = this.ctx!;
    const amp = 0.25 * Math.pow(n.v, 1.5);
    if (tr.drum) {
      const key = (n.k ?? '').toLowerCase();
      if (/kick|bd|boom|impact/.test(key)) {
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(150, when);
        o.frequency.exponentialRampToValueAtTime(45, when + 0.12);
        out.gain.setValueAtTime(amp * 2.4, when);
        out.gain.exponentialRampToValueAtTime(0.001, when + 0.35);
        o.connect(out);
        o.start(when);
        o.stop(when + 0.4);
        this.track(o, out);
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer();
      const f = ctx.createBiquadFilter();
      const hat = /hat|hh|ride|crash|cym|shaker|tamb|splash|china/.test(key);
      f.type = hat ? 'highpass' : 'bandpass';
      f.frequency.value = hat ? 7000 : 1800;
      const len = /crash|ride|ohat|open|china/.test(key) ? 0.6 : hat ? 0.06 : 0.16;
      out.gain.setValueAtTime(amp * 1.6, when);
      out.gain.exponentialRampToValueAtTime(0.001, when + len);
      src.connect(f).connect(out);
      src.start(when, Math.random() * 0.5, len + 0.05);
      this.track(src, f, out);
      return;
    }
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 440 * 2 ** (((n.p ?? 60) - 69) / 12);
    const rel = Math.max(0.05, Math.min(1, tr.release));
    out.gain.setValueAtTime(0, when);
    out.gain.linearRampToValueAtTime(amp, when + 0.008);
    out.gain.setValueAtTime(amp, when + Math.max(0.01, n.d));
    out.gain.setTargetAtTime(0, when + Math.max(0.01, n.d), rel / 4);
    o.connect(out);
    o.start(when);
    o.stop(when + n.d + rel + 0.1);
    this.track(o, out);
  }

  private noiseBuffer(): AudioBuffer {
    if (this.noise) return this.noise;
    const ctx = this.ctx!;
    const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = b;
    return b;
  }

  /** Peak level 0..1 of a track (or the master) right now. */
  level(inst?: string): number {
    return this.peakOf(inst ? this.tracks.get(inst)?.meter : this.masterMeter);
  }

  /** Peak level 0..1 of the master's left (0) or right (1) channel. */
  masterLevel(ch: 0 | 1): number {
    return this.peakOf(this.meterLR?.[ch]);
  }

  private peakOf(a: AnalyserNode | null | undefined): number {
    if (!a) return 0;
    if (!this.meterBuf || this.meterBuf.length !== a.fftSize) this.meterBuf = new Float32Array(a.fftSize);
    const buf = this.meterBuf;
    a.getFloatTimeDomainData(buf);
    let m = 0;
    for (let i = 0; i < buf.length; i++) {
      const x = Math.abs(buf[i]);
      if (x > m) m = x;
    }
    return m;
  }

  async loadRendered(url: string): Promise<void> {
    const ctx = this.ensure();
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    this.rendered = await ctx.decodeAudioData(await res.arrayBuffer());
  }

  dispose(): void {
    this.stopSources();
    this.liveOff();
    this.playing = false;
    void this.ctx?.close();
    this.ctx = null;
    this.tracks.clear();
  }
}
