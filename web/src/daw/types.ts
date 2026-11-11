// Data the studio-daw engine sends to the website DAW (see tools/studio-daw/studio_daw/editor.py).

/** One parsed event of a pattern track. Times in beats (quarter notes) from the pattern start. */
export interface DawEvent {
  t: number;
  /** sounding length (gate applied) */
  d: number;
  /** written length (what the editor shows and writes) */
  l: number;
  v: number;
  p?: number;
  k?: string;
  /** staccato */
  s?: 1;
  /** chord symbol the note came from */
  c?: string;
}

export type TrackForm = 'notes' | 'chords' | 'grid' | 'events' | 'voices';

export interface DawTrack {
  form: TrackForm;
  opts: Record<string, unknown>;
  length: number;
  events: DawEvent[];
}

export interface DawPattern {
  length: number;
  bars?: number | null;
  tracks: Record<string, DawTrack>;
}

export interface PlayEntry {
  pattern: string;
  opts: PlayOpts;
}
export interface PlayOpts {
  transpose?: number;
  velocity?: number;
  only?: string[] | string;
  offset?: number;
  bars?: number;
  [k: string]: unknown;
}

export interface DawSection {
  name: string;
  bars: number;
  bpm: number;
  transpose: number;
  startQ: number;
  startSec: number;
  play: PlayEntry[];
}

export interface ParamSpec {
  type?: 'number' | 'bool' | 'select' | 'text' | 'list' | 'json';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  scale?: 'log' | 'pow' | 'linear';
  options?: string[];
  label?: string;
  doc?: string;
}

export interface DawInstrument {
  kind: string;
  drum: boolean;
  describe: string;
  use: string | null;
  spec: Record<string, unknown>;
  octave: number;
  gate: number;
  release: number;
  soundKey: string;
  voice?: string;
  source?: string;
  doc?: string;
  params?: Record<string, unknown>;
  specs?: Record<string, ParamSpec>;
  sounds?: string[];
  parts?: Record<string, string>;
  program?: number;
  bank?: number;
  root?: number;
  pitched?: boolean;
  file?: string;
  presetMix?: Record<string, unknown>;
}

export interface EffectSpec {
  use: string;
  [k: string]: unknown;
}

export interface MixInfo {
  gain?: number;
  volume?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  reverb?: number;
  delay?: number;
  effects: EffectSpec[];
}

export interface MasterInfo {
  target?: number | null;
  ceiling?: number;
  fade_out?: number;
  effects: EffectSpec[];
}

export interface PluginError {
  file: string;
  source: string;
  error: string;
}

export interface SongInfo {
  title: string;
  bpm: number;
  time: string;
  meter: [number, number];
  barLen: number;
  swing: number;
  swingUnit: number;
  humanize: number;
  seed: number;
  tail: number;
  sampleRate: number;
  loop: number;
}

export interface SongModel {
  ok: true;
  version: number;
  song: SongInfo;
  instruments: Record<string, DawInstrument>;
  patterns: Record<string, DawPattern>;
  sections: DawSection[];
  implicitArrangement: boolean;
  mix: Record<string, MixInfo>;
  master: MasterInfo;
  duration: number;
  totalBars: number;
  warnings: string[];
  pluginErrors: PluginError[];
}

export interface ModelError {
  ok: false;
  error: string;
  pluginErrors?: PluginError[];
}

export interface CatalogVoice {
  name: string;
  doc: string;
  source: string;
  params: Record<string, unknown>;
  specs: Record<string, ParamSpec>;
  drum: boolean;
  kit?: boolean;
  sounds?: string[];
}
export interface CatalogEffect {
  name: string;
  doc: string;
  source: string;
  params: Record<string, unknown>;
  specs: Record<string, ParamSpec>;
}
export interface CatalogPackItem {
  use: string;
  kind: string;
  name: string;
  pack: string;
  tags: string[];
  drum: boolean;
  params?: Record<string, unknown>;
  codeAllowed?: boolean;
  program?: number;
  family?: string;
  sounds?: string[];
}
export interface Catalog {
  ok: true;
  voices: CatalogVoice[];
  effects: CatalogEffect[];
  packs: CatalogPackItem[];
  gmDrums: Record<string, number>;
  gmKitRows: string[];
  pluginErrors: PluginError[];
  warnings: string[];
}

export interface SoundEntry {
  f?: string;
  o?: number;
  n?: number;
  g?: number;
  c?: number;
  error?: string;
}
export interface SoundsResponse {
  ok: boolean;
  error?: string;
  sr: number;
  sounds: Record<string, { soundKey: string; release: number; entries: Record<string, SoundEntry> }>;
  errors: Record<string, string>;
  pluginErrors?: PluginError[];
}

export interface ExportResult {
  ok: boolean;
  title?: string;
  files: Record<string, string>;
  seconds?: number;
  lufs?: number;
  peak_dbfs?: number;
  tracks?: { name: string; notes: number; peak_dbfs: number; rms_dbfs: number }[];
  sections?: { name: string; start: number; bars: number }[];
  warnings: string[];
  render_seconds?: number;
}

/** Built-in effects the live preview can approximate in the browser (the rest: exact render only). */
export const LIVE_EFFECTS = new Set([
  'gain', 'pan', 'width', 'eq', 'lowpass', 'highpass', 'reverb', 'delay', 'chorus', 'distortion', 'compressor',
  'limiter', 'sidechain', 'tremolo', 'bitcrush', 'fade', 'saturate', 'autopan']);
