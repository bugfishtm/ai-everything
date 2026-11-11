// The Studio DAW: a visual editor for *.song.yaml files. The YAML stays the save format — every
// edit is written back into the text (only the touched part), the real studio-daw engine parses it,
// renders the sounds (also of plugins Claude wrote) and does the exact render and the exports.
import {
  AlertTriangle,
  Circle,
  CircleQuestionMark,
  Download,
  FileMusic,
  FolderOpen,
  LocateFixed,
  Metronome,
  Pause,
  Piano,
  Play,
  Plus,
  Redo2,
  Repeat,
  SkipBack,
  Sparkles,
  Square,
  Timer,
  Undo2,
  Volume2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, downloadUrl, errMsg, rawUrl, upload } from '../api';
import { ContextMenu, Modal, Spinner, useUi, type MenuItem } from '../components/ui';
import { basename } from '../util';
import { DawAudio, LIVE_HOLD } from './audio';
import { Arrangement } from './Arrangement';
import { NumField, TextField } from './controls';
import { KeyboardPanel } from './Keyboard';
import { LivePlayer, liveTarget, TYPING_CONTROL, TYPING_KEYS, typingLabels, typingLabelsDefault } from './live';
import MidiImportDialog from './MidiImport';
import { MidiIO } from './midiio';
import { Mixer } from './Mixer';
import { gridRows, parseDuration } from './notation';
import * as ops from './ops';
import { InstrumentsPanel, SongPanel, SoundPicker, specForUse } from './Panels';
import { PianoRoll } from './PianoRoll';
import { mergeTake, REC_QUANT, Recorder, type RecLoc, type RecNote, type RecTake } from './record';
import { wantedSounds } from './sounds';
import { StepGrid } from './StepGrid';
import { compileTimeline, patternScope, secToQ, sectionLenSec, songDuration } from './timeline';
import { TrackList } from './TrackList';
import { Lcd, MidiMenu, ShortcutsDialog, TapTempo } from './Transport';
import type { Catalog, DawEvent, ExportResult, ModelError, PlayEntry, SongModel } from './types';
import { freeSongPath, STARTER } from './starter';
import { SongDoc } from './yamlEdit';
import './daw.css';

export interface DawEditorProps {
  projectId: number;
  path: string;
  text: string;
  onChange: (text: string) => void;
  onSave: () => void | Promise<void>;
  refreshKey: number;
  onOpenFile?: (path: string) => void;
}

type Tab = 'pattern' | 'mixer' | 'instruments' | 'song';
/** What the transport plays: the arrangement, or the selected pattern alone in a loop. */
type Scope = 'song' | 'pattern';
interface Snap {
  text: string;
  model: SongModel;
}

// small settings of the editor that are remembered in this browser
function pref(key: string, def: string): string {
  try {
    return localStorage.getItem(key) ?? def;
  } catch {
    return def;
  }
}
function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}
/** Is the focus in something the user types text into? (sliders and buttons do not count) */
function textTarget(el: HTMLElement): boolean {
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !/^(range|checkbox|radio|button|submit|reset|color|file)$/i.test((el as HTMLInputElement).type);
}

export default function DawEditor({ projectId, path, text, onChange, onSave, refreshKey, onOpenFile }: DawEditorProps) {
  const ui = useUi();
  const audio = useMemo(() => new DawAudio(projectId), [projectId]);
  const midi = useMemo(() => new MidiIO(), []);
  const live = useMemo(() => new LivePlayer(audio), [audio]);
  const [model, setModelState] = useState<SongModel | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [tab, setTab] = useState<Tab>('pattern');
  const [wantPattern, setSelPattern] = useState<string | null>(null);
  const [wantTrack, setSelTrack] = useState<string | null>(null);
  const [selSection, setSelSection] = useState<number | null>(null);
  const [selInst, setSelInst] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState<{ a: number; b: number } | null>(null);
  const [loopOn, setLoopOn] = useState(false);
  const [metro, setMetro] = useState(false);
  const [mode, setMode] = useState<'live' | 'rendered'>('live');
  const [rendered, setRendered] = useState<{ text: string; report: ExportResult } | null>(null);
  const [rendering, setRendering] = useState(false);
  const [monitor, setMonitor] = useState(0.8);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const [, setBankTick] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [midiImport, setMidiImport] = useState<{ name: string; buf: ArrayBuffer } | null>(null);
  const [playOpts, setPlayOpts] = useState<{ i: number; entry: PlayEntry } | null>(null);
  const [addInst, setAddInst] = useState(false);
  const [showText, setShowText] = useState(false);
  const [arrH, setArrH] = useState(() => Math.max(160, Math.min(420, Math.round(window.innerHeight * 0.3))));
  const [dropping, setDropping] = useState(false);
  const [scope, setScope] = useState<Scope>('song');
  const [recording, setRecording] = useState(false);
  const [countIn, setCountIn] = useState(() => Math.min(2, Math.max(0, Math.round(Number(pref('daw.countin', '1'))) || 0)));
  const [recQ, setRecQ] = useState(() => {
    const v = Number(pref('daw.recq', '0.25'));
    return REC_QUANT.find((q) => Math.abs(q.value - v) < 1e-6)?.value ?? 0.25;
  });
  const [follow, setFollow] = useState(() => pref('daw.follow', '1') !== '0');
  const [keysOpen, setKeysOpen] = useState(() => pref('daw.keys', '0') === '1');
  const [typing, setTyping] = useState(() => pref('daw.typing', '1') !== '0');
  const [kbOct, setKbOct] = useState(4);
  const [kbVel, setKbVel] = useState(0.8);
  const [labels, setLabels] = useState<Record<string, string>>(typingLabelsDefault);
  const [, setMidiTick] = useState(0);
  const [help, setHelp] = useState(false);

  const textRef = useRef(text);
  textRef.current = text;
  const modelRef = useRef<SongModel | null>(null);
  const validated = useRef<string | null>(null);
  const undoStack = useRef<Snap[]>([]);
  const redoStack = useRef<Snap[]>([]);
  const lastEdit = useRef<{ key?: string; at: number }>({ at: 0 });
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<Scope>(scope);
  scopeRef.current = scope;
  /** where the song stood when the transport went to Pattern mode */
  const songPos = useRef(0);
  const takeSeq = useRef(0);
  /** a note from a MIDI input that is also the output must not be sent back to it */
  const thruBlock = useRef(false);
  const outHeld = useRef(new Map<string, { note: number; ch: number }>());
  const typingDown = useRef(new Map<string, { p?: number; k?: string }>());
  const liveWant = useRef<{ inst: string; pitches: Set<number>; timer: ReturnType<typeof setTimeout> | undefined }>({ inst: '', pitches: new Set(), timer: undefined });

  const setModel = useCallback((m: SongModel) => {
    modelRef.current = m;
    setModelState(m);
  }, []);

  const doc = useMemo(() => new SongDoc(text), [text]);
  const timeline = useMemo(() => (model ? compileTimeline(model) : []), [model]);
  // effective selection: a pattern/track just added may not be in the engine's model yet
  const selPattern = model && wantPattern && model.patterns[wantPattern] ? wantPattern : model ? (Object.keys(model.patterns)[0] ?? null) : null;
  const selTracks = model && selPattern ? Object.keys(model.patterns[selPattern].tracks) : [];
  const selTrack = wantTrack && selTracks.includes(wantTrack) ? wantTrack : (selTracks[0] ?? null);
  // the latest selection and settings for callbacks that run outside of React's render (MIDI, timers)
  const S = useRef({ selPattern, selTrack, loop, loopOn, recQ, countIn });
  S.current = { selPattern, selTrack, loop, loopOn, recQ, countIn };
  // what the transport plays: the song, or (Pattern mode) the selected pattern alone
  const playModel = useMemo(() => (model && scope === 'pattern' && selPattern && model.patterns[selPattern] ? patternScope(model, selPattern) : model), [model, scope, selPattern]);
  const playTimeline = useMemo(() => (playModel && playModel !== model ? compileTimeline(playModel) : timeline), [playModel, model, timeline]);
  // the instrument live input plays: the selected track, or the instrument open on the Instruments tab
  const liveInst = model ? (tab === 'instruments' ? (selInst && model.instruments[selInst] ? selInst : (Object.keys(model.instruments)[0] ?? null)) : selTrack) : null;
  const liveIns = model && liveInst ? model.instruments[liveInst] : undefined;
  const liveKey = liveInst && liveIns ? `${liveInst}|${liveIns.drum}|${liveIns.octave}|${(liveIns.sounds ?? []).join(',')}` : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps -- liveKey stands for the instrument's properties used
  const target = useMemo(() => (liveInst && liveIns ? liveTarget(liveInst, liveIns, catalog) : null), [liveKey, catalog]);

  // ---- engine: parse the text (debounced), catalog -------------------------------------------
  const refresh = useCallback(
    async (t: string) => {
      setSyncing(true);
      try {
        const r = await api<SongModel | ModelError>(`/projects/${projectId}/daw/model`, { body: { path, text: t } });
        if (t !== textRef.current) return; // the text moved on, a newer request follows
        validated.current = t;
        if (r.ok) {
          setModel(r);
          setEngineError(null);
        } else setEngineError(r.error);
      } catch (err) {
        if (t === textRef.current) setEngineError(errMsg(err));
      } finally {
        setSyncing(false);
      }
    },
    [projectId, path, setModel],
  );

  useEffect(() => {
    if (validated.current === text) return;
    const h = setTimeout(() => void refresh(text), modelRef.current ? 450 : 0);
    return () => clearTimeout(h);
  }, [text, refresh]);

  const loadCatalog = useCallback(() => {
    api<Catalog>(`/projects/${projectId}/daw/catalog`)
      .then(setCatalog)
      .catch(() => {});
  }, [projectId]);
  useEffect(() => loadCatalog(), [loadCatalog]);

  // project files changed (Claude edited a plugin, a sample …): new instruments, new sounds
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    loadCatalog();
    validated.current = null;
    void refresh(textRef.current);
  }, [refreshKey, loadCatalog, refresh]);

  // ---- audio ------------------------------------------------------------------------------
  useEffect(() => {
    audio.bank.onChange = () => setBankTick((x) => x + 1);
    return () => audio.dispose();
  }, [audio]);
  useEffect(() => {
    if (!playModel) return;
    audio.setModel(playModel, playTimeline);
    if (playModel !== model) {
      // Pattern mode: the pattern loops
      const end = songDuration(playModel);
      audio.loop = { a: 0, b: end };
      audio.loopOn = true;
      if (audio.position() >= end) audio.seek(0);
    } else {
      audio.loop = loop;
      audio.loopOn = loopOn && !!loop;
    }
  }, [audio, playModel, playTimeline, model, loop, loopOn]);
  useEffect(() => {
    audio.metronome = metro;
  }, [audio, metro]);
  useEffect(() => {
    audio.mode = mode;
  }, [audio, mode]);

  // the sounds the song needs, rendered by the engine (debounced; only missing ones) — in Pattern mode
  // also those of the looped pattern, which may not be part of the arrangement
  useEffect(() => {
    if (!model) return;
    const h = setTimeout(() => {
      audio.ensure();
      void audio.bank.request(path, textRef.current, model, wantedSounds(model, playTimeline === timeline ? timeline : [...timeline, ...playTimeline]));
    }, 500);
    return () => clearTimeout(h);
  }, [audio, model, timeline, playTimeline, path]);

  // ---- edits ------------------------------------------------------------------------------
  const apply = useCallback(
    (fn: (d: SongDoc, m: SongModel) => ops.EditResult, coalesce?: string): boolean => {
      const m = modelRef.current;
      if (!m) return false;
      const cur = textRef.current;
      let r: ops.EditResult;
      try {
        const d = new SongDoc(cur);
        if (d.errors.length) throw new Error(`The file has a YAML error — fix it in the Code view first: ${d.errors[0]}`);
        r = fn(d, m);
      } catch (err) {
        ui.toast(errMsg(err), 'error');
        return false;
      }
      if (r.doc.text === cur) {
        if (r.model) setModel(r.model);
        return true;
      }
      const now = Date.now();
      // edits with the same key shortly after each other are one undo step; a recorded take ("take:…") always is
      const sticky = !!coalesce && coalesce.startsWith('take:');
      if (!(coalesce && lastEdit.current.key === coalesce && (sticky || now - lastEdit.current.at < 2000))) {
        undoStack.current.push({ text: cur, model: m });
        if (undoStack.current.length > 300) undoStack.current.shift();
        redoStack.current = [];
      }
      lastEdit.current = { key: coalesce, at: now };
      textRef.current = r.doc.text;
      if (r.model) setModel(r.model);
      setHist({ undo: undoStack.current.length, redo: 0 });
      onChange(r.doc.text);
      return true;
    },
    [onChange, setModel, ui],
  );

  const undo = useCallback(() => {
    const e = undoStack.current.pop();
    const m = modelRef.current;
    if (!e || !m) return;
    redoStack.current.push({ text: textRef.current, model: m });
    textRef.current = e.text;
    setModel(e.model);
    lastEdit.current = { at: 0 };
    setHist({ undo: undoStack.current.length, redo: redoStack.current.length });
    onChange(e.text);
  }, [onChange, setModel]);
  const redo = useCallback(() => {
    const e = redoStack.current.pop();
    const m = modelRef.current;
    if (!e || !m) return;
    undoStack.current.push({ text: textRef.current, model: m });
    textRef.current = e.text;
    setModel(e.model);
    lastEdit.current = { at: 0 };
    setHist({ undo: undoStack.current.length, redo: redoStack.current.length });
    onChange(e.text);
  }, [onChange, setModel]);

  useEffect(() => {
    if (model && selSection !== null && selSection >= model.sections.length) setSelSection(null);
  }, [model, selSection]);

  // ---- transport ---------------------------------------------------------------------------
  const position = useCallback(() => audio.position(), [audio]);

  /** Where a time of the transport falls inside a pattern (null where the pattern does not play). */
  const locate = useCallback(
    (pattern: string, t: number): RecLoc | null => {
      const m = modelRef.current;
      const pat = m?.patterns[pattern];
      if (!m || !pat) return null;
      const barLen = m.song.barLen;
      if (scopeRef.current === 'pattern') {
        const bpm = audio.model?.sections[0]?.bpm ?? m.song.bpm;
        const plen = pat.length;
        if (!(plen > 0)) return null;
        return { q: ((Math.max(0, t) * bpm) / 60) % plen, plen, transpose: 0, bpm };
      }
      const sec = m.sections.find((x) => t >= x.startSec - 1e-9 && t < x.startSec + sectionLenSec(x, barLen));
      const entry = sec?.play.find((x) => x.pattern === pattern);
      if (!sec || !entry) return null;
      const plen = entry.opts.bars ? Number(entry.opts.bars) * barLen : pat.length;
      const q = secToQ(m, t) - sec.startQ - Number(entry.opts.offset ?? 0) * barLen;
      if (q < -1e-9 || !(plen > 0)) return null;
      return { q: Math.max(0, q) % plen, plen, transpose: (sec.transpose || 0) + (Number(entry.opts.transpose ?? 0) || 0), bpm: sec.bpm };
    },
    [audio],
  );

  // recording: the recorder times the notes, they are written with the usual edit (one undo step per take)
  const commitRef = useRef<(take: RecTake, notes: RecNote[]) => boolean>(() => false);
  const recorder = useMemo(() => new Recorder(audio, locate, (take, notes) => commitRef.current(take, notes)), [audio, locate]);
  commitRef.current = (take, notes) =>
    apply((d, m) => {
      const track = m.patterns[take.pattern]?.tracks[take.inst];
      if (!track) throw new Error(`The track ${take.inst} of ${take.pattern} is gone — the recording stopped`);
      const { events, form } = mergeTake(track, take, notes);
      return ops.writeTrack(d, m, take.pattern, take.inst, events, form);
    }, `take:${take.id}`);

  const endTake = useCallback(() => {
    if (!recorder.take) return;
    const n = recorder.end();
    setRecording(false);
    ui.toast(n ? `Recorded ${n} note${n === 1 ? '' : 's'} — one Undo removes the take` : 'Nothing was played, nothing recorded', n ? 'ok' : 'info');
  }, [recorder, ui]);
  useEffect(() => {
    recorder.onAbort = () => setRecording(false);
    return () => recorder.cancel();
  }, [recorder]);
  // the take belongs to one track: selecting another one ends it
  useEffect(() => {
    const take = recorder.take;
    if (take && (take.pattern !== selPattern || take.inst !== selTrack)) endTake();
  }, [recorder, selPattern, selTrack, endTake]);

  const play = useCallback(
    async (from?: number, countBars = 0) => {
      if (audio.mode === 'rendered' && !audio.rendered) {
        ui.toast('Render first (exact sound), or switch to Live', 'info');
        return;
      }
      const lp = audio.loopOn && audio.loop ? audio.loop : null;
      let start = from ?? audio.position();
      if (lp && (start < lp.a || start >= lp.b)) start = lp.a;
      if (start >= audio.duration - 0.05) start = lp ? lp.a : 0;
      await audio.play(start, countBars);
      setPlaying(true);
    },
    [audio, ui],
  );
  const stop = useCallback(() => {
    endTake();
    audio.stop();
    midi.flush();
    setPlaying(false);
  }, [audio, endTake, midi]);
  const toggle = useCallback(() => (audio.playing ? stop() : void play()), [audio, play, stop]);
  const seek = useCallback(
    (t: number) => {
      midi.flush();
      audio.seek(t);
      if (!audio.playing) setBankTick((x) => x + 1);
    },
    [audio, midi],
  );
  const toStart = useCallback(() => seek(audio.loopOn && audio.loop ? audio.loop.a : 0), [audio, seek]);
  useEffect(() => {
    audio.onStop = () => {
      endTake();
      midi.flush();
      setPlaying(false);
    };
  }, [audio, endTake, midi]);

  /** Song: the transport plays the arrangement. Pattern: it loops the selected pattern alone. */
  const switchScope = useCallback(
    (next: Scope) => {
      if (next === scopeRef.current) return;
      const m = modelRef.current;
      const p = S.current.selPattern;
      if (next === 'pattern' && !(m && p && m.patterns[p])) return;
      endTake();
      audio.stop();
      midi.flush();
      setPlaying(false);
      if (scopeRef.current === 'song') songPos.current = audio.position();
      scopeRef.current = next;
      setScope(next);
      if (!m) return;
      // the engine gets the new material right away (the effect above repeats it after the next render)
      if (next === 'pattern' && p) {
        const pm = patternScope(m, p);
        audio.mode = 'live';
        setMode('live');
        audio.setModel(pm, compileTimeline(pm));
        audio.loop = { a: 0, b: songDuration(pm) };
        audio.loopOn = true;
        audio.seek(0);
      } else {
        audio.setModel(m, compileTimeline(m));
        audio.loop = S.current.loop;
        audio.loopOn = S.current.loopOn && !!S.current.loop;
        audio.seek(songPos.current);
      }
    },
    [audio, endTake, midi],
  );
  /** A click on the song timeline: the transport goes there (and back to the song). */
  const seekSong = useCallback(
    (t: number) => {
      if (scopeRef.current === 'pattern') switchScope('song');
      seek(t);
    },
    [seek, switchScope],
  );

  /** Record on / off. Starts the transport (with the count-in) when it is not running. */
  const record = useCallback(async () => {
    if (recorder.take) {
      endTake();
      return;
    }
    const m = modelRef.current;
    const { selPattern: p, selTrack: t } = S.current;
    const ins = m && t ? m.instruments[t] : undefined;
    const track = m && p && t ? m.patterns[p]?.tracks[t] : undefined;
    if (!m || !p || !t || !ins || !track) {
      ui.toast('Select a pattern and a track to record into', 'info');
      return;
    }
    setTab('pattern');
    if (audio.mode === 'rendered') {
      audio.stop();
      setPlaying(false);
      audio.mode = 'live';
      setMode('live');
    }
    const starting = !audio.playing;
    if (scopeRef.current === 'song') {
      const lp = audio.loopOn && audio.loop ? audio.loop : null;
      let start = audio.position();
      if (starting) {
        if (lp && (start < lp.a || start >= lp.b)) start = lp.a;
        if (start >= audio.duration - 0.05) start = lp ? lp.a : 0;
      }
      if (!locate(p, start)) {
        if (starting) {
          switchScope('pattern');
          ui.toast(`"${p}" does not play at the playhead — recording in Pattern mode (the pattern loops; "Song" switches back)`, 'info');
        } else ui.toast(`"${p}" does not play here — notes are recorded as soon as the song reaches it`, 'info');
      }
    }
    recorder.begin({
      id: ++takeSeq.current,
      pattern: p,
      inst: t,
      drum: ins.drum,
      quant: S.current.recQ,
      step: parseDuration(String(track.opts.step ?? 's'), m.song.barLen) ?? 0.25,
      gate: track.form === 'chords' ? Number(track.opts.gate ?? 0.98) : Number(track.opts.gate ?? ins.gate),
    });
    setRecording(true);
    if (starting) await play(undefined, S.current.countIn);
  }, [audio, endTake, locate, play, recorder, switchScope, ui]);

  const audition = useCallback(
    (inst: string, n: { p?: number; k?: string; v?: number; d?: number }) => {
      const m = modelRef.current;
      if (!m?.instruments[inst]) return;
      const note = { p: n.p, k: n.k, v: n.v ?? 0.8, d: n.d ?? 0.5 };
      void audio.audition(inst, note);
      void audio.bank.request(path, textRef.current, m, wantedSounds(m, [], [{ inst, ...note }]));
    },
    [audio, path],
  );

  // ---- live input: MIDI keyboard, on-screen keyboard, computer keyboard ------------------------
  useEffect(() => {
    live.setTarget(target);
  }, [live, target]);
  const targetInst = target?.inst;
  const targetOct = target && !target.drum ? target.octave : undefined;
  useEffect(() => {
    if (targetInst && targetOct !== undefined) setKbOct(targetOct);
  }, [targetInst, targetOct]);

  /** Ask the engine for a long sound near this pitch (held notes need more than the song's short ones). */
  const wantLiveSound = useCallback(
    (inst: string, pitch: number) => {
      const w = liveWant.current;
      if (w.inst !== inst) {
        w.inst = inst;
        w.pitches.clear();
      }
      w.pitches.add(Math.max(0, Math.min(126, Math.round(pitch / 3) * 3)));
      if (w.timer !== undefined) return;
      w.timer = setTimeout(() => {
        w.timer = undefined;
        const m = modelRef.current;
        const extra = [...w.pitches].map((x) => ({ inst: w.inst, p: x, v: 0.8, d: LIVE_HOLD }));
        w.pitches.clear();
        if (m?.instruments[w.inst] && extra.length) void audio.bank.request(path, textRef.current, m, wantedSounds(m, [], extra));
      }, 150);
    },
    [audio, path],
  );
  useEffect(() => {
    const w = liveWant.current;
    return () => {
      if (w.timer !== undefined) clearTimeout(w.timer);
      w.timer = undefined;
    };
  }, []);

  // sounds for playing live: a few long notes across the keyboard (the engine renders them once), the kit's hits
  const liveActive = keysOpen || midi.activeInputs > 0;
  const liveSoundKey = liveIns?.soundKey;
  useEffect(() => {
    if (!liveActive || !liveInst || !liveSoundKey) return;
    const h = setTimeout(() => {
      const m = modelRef.current;
      const ins = m?.instruments[liveInst];
      if (!m || !ins) return;
      let extra: { inst: string; p?: number; k?: string; v: number; d: number }[];
      if (ins.drum) extra = (ins.sounds?.length ? ins.sounds : (catalog?.gmKitRows ?? [])).slice(0, 40).map((k) => ({ inst: liveInst, k, v: 0.8, d: 0.25 }));
      else {
        const c = 12 * (Math.max(0, Math.min(8, Math.round(ins.octave))) + 1);
        extra = [];
        for (let x = Math.max(0, c - 12); x <= Math.min(126, c + 36); x += 3) extra.push({ inst: liveInst, p: x, v: 0.8, d: LIVE_HOLD });
      }
      void audio.bank.request(path, textRef.current, m, wantedSounds(m, [], extra));
    }, 400);
    return () => clearTimeout(h);
  }, [audio, path, liveActive, liveInst, liveSoundKey, catalog]);

  // what is played goes to the recorder and to the MIDI output
  useEffect(() => {
    live.onStart = (n, t) => {
      if (recorder.take && recorder.take.inst === t.inst) recorder.noteOn(n);
      if (n.p !== undefined) wantLiveSound(t.inst, n.p);
      if (thruBlock.current || !midi.output) return;
      const note = n.p ?? (n.k !== undefined ? t.noteOf.get(n.k) : undefined);
      if (note === undefined) return;
      const ch = t.drum ? 9 : 0;
      midi.noteOn(note, n.v, ch);
      outHeld.current.set(n.id, { note, ch });
    };
    live.onEnd = (n) => {
      recorder.noteOff(n.id);
      const o = outHeld.current.get(n.id);
      if (!o) return;
      outHeld.current.delete(n.id);
      midi.noteOff(o.note, o.ch);
    };
    return () => {
      live.panic();
      live.onStart = undefined;
      live.onEnd = undefined;
    };
  }, [live, recorder, midi, wantLiveSound]);

  // MIDI devices: keyboards play the live instrument; the output gets the selected track while the song runs
  useEffect(() => {
    midi.onChange = () => setMidiTick((x) => x + 1);
    midi.onEvent = (e) => {
      if (e.type === 'on') {
        thruBlock.current = midi.isOutput(e.port);
        live.pitchOn(e.note, e.vel);
        thruBlock.current = false;
      } else if (e.type === 'off') live.pitchOff(e.note);
      else if (e.type === 'sustain') live.pedal(e.on);
      else live.panic();
    };
    void midi.resume();
    return () => midi.dispose();
  }, [midi, live]);
  useEffect(() => {
    audio.onNote = (n, when) => {
      const t = live.target;
      if (!midi.output || !t || n.inst !== t.inst) return;
      const note = n.p ?? (n.k !== undefined ? t.noteOf.get(n.k) : undefined);
      if (note === undefined) return;
      const at = performance.now() + (when - audio.now() + audio.latency()) * 1000;
      midi.schedule(note, n.v, at, n.d * 1000, t.drum ? 9 : 0);
    };
    return () => {
      audio.onNote = undefined;
    };
  }, [audio, midi, live]);
  const panic = useCallback(() => {
    live.panic();
    midi.allOff();
    outHeld.current.clear();
  }, [live, midi]);

  // computer keyboard as a piano ("musical typing"): held keys end when the focus goes away
  const releaseTyping = useCallback(() => {
    for (const h of typingDown.current.values()) {
      if (h.k !== undefined) live.drumOff(h.k);
      else if (h.p !== undefined) live.pitchOff(h.p);
    }
    typingDown.current.clear();
  }, [live]);
  useEffect(() => {
    window.addEventListener('blur', releaseTyping);
    return () => window.removeEventListener('blur', releaseTyping);
  }, [releaseTyping]);
  useEffect(() => {
    if (!keysOpen || !typing) releaseTyping();
  }, [keysOpen, typing, releaseTyping]);
  useEffect(() => {
    let alive = true;
    void typingLabels().then((l) => {
      if (alive) setLabels(l);
    });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    savePref('daw.countin', String(countIn));
    savePref('daw.recq', String(recQ));
    savePref('daw.follow', follow ? '1' : '0');
    savePref('daw.keys', keysOpen ? '1' : '0');
    savePref('daw.typing', typing ? '1' : '0');
  }, [countIn, recQ, follow, keysOpen, typing]);
  /** Give the keyboard focus back to the DAW (after a menu or select took it): shortcuts and typing keys work again. */
  const focusRoot = useCallback(() => rootRef.current?.focus({ preventScroll: true }), []);

  // keyboard: space play/stop, ctrl+z/y undo/redo, ctrl+s save, R record, M metronome, L loop, ? help;
  // with the keyboard panel open the letter keys play notes
  const onKey = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;
    // keys pressed in a dialog (rendered outside of the DAW's element) are not for the typing keys and letter shortcuts
    const inside = !!rootRef.current?.contains(el);
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void onSave();
      return;
    }
    if (inside && keysOpen && typing && !mod && !e.altKey && !textTarget(el)) {
      if (e.code in TYPING_KEYS) {
        e.preventDefault();
        const t = live.target;
        if (e.repeat || typingDown.current.has(e.code) || !t) return;
        const semi = TYPING_KEYS[e.code];
        if (t.drum) {
          const k = t.sounds[semi];
          if (k === undefined) return;
          typingDown.current.set(e.code, { k });
          live.drumOn(k, kbVel);
        } else {
          const pitch = 12 * (kbOct + 1) + semi;
          if (pitch > 127) return;
          typingDown.current.set(e.code, { p: pitch });
          live.pitchOn(pitch, kbVel);
        }
        return;
      }
      const ctl = TYPING_CONTROL[e.code];
      if (ctl) {
        e.preventDefault();
        if (ctl === 'oct-') setKbOct((o) => Math.max(0, o - 1));
        else if (ctl === 'oct+') setKbOct((o) => Math.min(8, o + 1));
        else setKbVel((v) => Math.min(1, Math.max(0.1, Math.round((v + (ctl === 'vel+' ? 0.1 : -0.1)) * 20) / 20)));
        return;
      }
    }
    if (inField) return;
    if (e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if (mod || e.altKey || e.repeat || !inside) {
      /* not ours */
    } else if (e.key === 'Home') {
      e.preventDefault();
      toStart();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      void record();
    } else if (e.key === 'm' || e.key === 'M') {
      setMetro((v) => !v);
    } else if (e.key === 'l' || e.key === 'L') {
      if (scope === 'song' && loop) setLoopOn((v) => !v);
    } else if (e.key === '?') {
      setHelp(true);
    }
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    const h = typingDown.current.get(e.code);
    if (!h) return;
    typingDown.current.delete(e.code);
    if (h.k !== undefined) live.drumOff(h.k);
    else if (h.p !== undefined) live.pitchOff(h.p);
  };

  // ---- exact render, exports ---------------------------------------------------------------
  const base = basename(path).split('.')[0] || 'song';
  const runExport = useCallback(
    async (body: { what: string[]; zip?: boolean; preview?: boolean; from?: number; to?: number; name?: string }): Promise<ExportResult | null> => {
      try {
        return await api<ExportResult>(`/projects/${projectId}/daw/export`, { body: { path, text: textRef.current, ...body } });
      } catch (err) {
        ui.toast(errMsg(err), 'error');
        return null;
      }
    },
    [path, projectId, ui],
  );

  const render = useCallback(async () => {
    if (rendering) return;
    setRendering(true);
    const t = textRef.current;
    try {
      const r = await runExport({ what: ['wav', 'mp3'], preview: true });
      if (!r?.files.wav) return;
      await audio.loadRendered(`${rawUrl(projectId, r.files.wav)}?v=${Date.now()}`);
      setRendered({ text: t, report: r });
      switchScope('song');
      setMode('rendered');
      ui.toast(`Rendered ${r.seconds}s · ${r.lufs} LUFS · peak ${r.peak_dbfs} dBFS`, 'ok');
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setRendering(false);
    }
  }, [audio, projectId, rendering, runExport, switchScope, ui]);

  const download = (rel: string) => {
    const a = document.createElement('a');
    a.href = downloadUrl(projectId, rel);
    a.download = basename(rel);
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const downloadYaml = () => {
    const blob = new Blob([textRef.current], { type: 'text/yaml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = basename(path);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  // ---- open / import / new -----------------------------------------------------------------
  const freeName = (dir: string, name: string) => freeSongPath(projectId, dir, name);
  const songDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : 'src';

  const openFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (/\.midi?$/i.test(f.name)) {
        setMidiImport({ name: f.name, buf: await f.arrayBuffer() });
        continue;
      }
      if (!/\.ya?ml$/i.test(f.name)) {
        ui.toast(`${f.name}: open a .song.yaml / .yaml song or a .mid file`, 'error');
        continue;
      }
      const target = await freeName(songDir, f.name);
      const form = new FormData();
      form.append('file', new File([await f.text()], basename(target), { type: 'text/yaml' }));
      try {
        await upload(`/projects/${projectId}/upload?dir=${encodeURIComponent(songDir)}`, form);
        ui.toast(`Opened ${target}`);
        onOpenFile?.(target);
      } catch (err) {
        ui.toast(errMsg(err), 'error');
      }
    }
  };

  const replaceWith = async (f: File) => {
    const t = await f.text();
    const ok = await ui.confirm({ title: 'Load this file into the editor?', body: `${f.name} replaces the content of ${path} (unsaved until you save; Undo brings the old song back).`, confirm: 'Load' });
    if (!ok || !modelRef.current) return;
    undoStack.current.push({ text: textRef.current, model: modelRef.current });
    setHist({ undo: undoStack.current.length, redo: 0 });
    onChange(t);
  };

  const newSong = async () => {
    const name = await ui.prompt('New song', 'new-song', 'File name (in the same folder)');
    if (!name) return;
    const target = await freeName(songDir, name);
    const title = basename(target).split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    try {
      await api(`/projects/${projectId}/file`, { method: 'PUT', body: { path: target, content: STARTER(title) } });
      onOpenFile?.(target);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  // ---- derived -------------------------------------------------------------------------------
  const pattern = model && selPattern ? model.patterns[selPattern] : null;
  const track = pattern && selTrack ? pattern.tracks[selTrack] : null;
  const ins = model && selTrack ? model.instruments[selTrack] : null;
  const barLen = model?.song.barLen ?? 4;
  const beatLen = model ? 4 / model.song.meter[1] : 1;

  const patternPlayhead = useCallback(() => {
    if (!selPattern || !audio.playing) return null;
    return locate(selPattern, audio.position())?.q ?? null;
  }, [audio, selPattern, locate]);

  const rawTrack = selPattern && selTrack ? doc.get(['patterns', selPattern, selTrack]) : undefined;
  const gridText = typeof rawTrack === 'string' ? rawTrack : rawTrack && typeof rawTrack === 'object' && !Array.isArray(rawTrack) && typeof (rawTrack as Record<string, unknown>).grid === 'string' ? String((rawTrack as Record<string, unknown>).grid) : '';

  const writeEvents = (events: DawEvent[], rows?: string[]) => {
    if (!selPattern || !selTrack) return;
    apply((d, m) => ops.writeTrack(d, m, selPattern, selTrack, events, undefined, rows));
  };

  const renderStale = rendered && rendered.text !== text;
  const bankErrors = audio.bank.errors;

  // ---- pattern / clip / section menus ----------------------------------------------------------
  const patternMenu = (p: string, x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        { label: 'Edit pattern', onClick: () => editPattern(p) },
        {
          label: 'Rename…',
          onClick: async () => {
            const n = await ui.prompt('Rename pattern', p);
            if (n && n !== p && apply((d, m) => ops.renamePattern(d, m, p, n))) setSelPattern(n.trim());
          },
        },
        {
          label: 'Duplicate',
          onClick: () => {
            let n = `${p}2`;
            for (let i = 3; modelRef.current?.patterns[n]; i++) n = `${p}${i}`;
            if (apply((d, m) => ops.duplicatePattern(d, m, p, n))) setSelPattern(n);
          },
        },
        { label: 'Length (bars)…', onClick: () => void patternBars(p) },
        { divider: true, label: '', onClick: () => {} },
        {
          label: 'Delete pattern',
          danger: true,
          onClick: async () => {
            if (await ui.confirm({ title: `Delete pattern ${p}?`, body: 'It is also removed from every section.', confirm: 'Delete', danger: true })) apply((d, m) => ops.deletePattern(d, m, p));
          },
        },
      ],
    });

  const patternBars = async (p: string) => {
    const cur = modelRef.current?.patterns[p]?.bars;
    const v = await ui.prompt(`Length of ${p} in bars (empty = from its notes)`, cur ? String(cur) : '');
    if (v === null) return;
    const n = v.trim() ? Number(v) : null;
    if (n !== null && !(n > 0)) return ui.toast('enter a number of bars', 'error');
    apply((d, m) => ops.setPatternBars(d, m, p, n));
  };

  const editPattern = (p: string) => {
    setSelPattern(p);
    setTab('pattern');
  };

  const newPattern = async () => {
    const m = modelRef.current;
    if (!m) return;
    let n = 'pattern1';
    for (let i = 2; m.patterns[n]; i++) n = `pattern${i}`;
    const name = await ui.prompt('New pattern', n, 'Name');
    if (!name) return;
    const inst = selTrack && m.instruments[selTrack] ? selTrack : Object.keys(m.instruments)[0];
    if (apply((d, mm) => ops.addPattern(d, mm, name, inst, 1))) {
      setSelPattern(name.trim());
      setSelTrack(inst);
      setTab('pattern');
    }
  };

  const sectionAction = (i: number, action: 'left' | 'right' | 'duplicate' | 'delete' | 'loop' | 'add') => {
    const m = modelRef.current;
    if (!m) return;
    if (action === 'left' && i > 0 && apply((d, mm) => ops.moveSection(d, mm, i, i - 1))) setSelSection(i - 1);
    if (action === 'right' && i < m.sections.length - 1 && apply((d, mm) => ops.moveSection(d, mm, i, i + 1))) setSelSection(i + 1);
    if (action === 'duplicate' && apply((d, mm) => ops.duplicateSection(d, mm, i))) setSelSection(i + 1);
    if (action === 'delete') {
      apply((d, mm) => ops.deleteSection(d, mm, i));
      setSelSection(null);
    }
    if (action === 'loop') {
      const s = m.sections[i];
      setLoop({ a: s.startSec, b: s.startSec + (s.bars * m.song.barLen * 60) / s.bpm });
      setLoopOn(true);
    }
    if (action === 'add') {
      const prev = m.sections[m.sections.length - 1];
      if (apply((d, mm) => ops.addSection(d, mm, mm.sections.length, { section: `part${mm.sections.length + 1}`, bars: prev?.bars ?? 4, play: prev?.play.map((p) => p.pattern) ?? [] })))
        setSelSection(m.sections.length);
    }
  };

  // ---- render ----------------------------------------------------------------------------------
  if (!model) {
    return (
      <div className="daw daw-loading">
        {engineError ? (
          <div className="notice error" style={{ maxWidth: 720 }}>
            <AlertTriangle size={16} />
            <div>
              <b>The song cannot be read</b>
              <pre>{engineError}</pre>
              <div className="small">Fix it in the Code view (or ask Claude) — the DAW opens as soon as the engine can read it.</div>
            </div>
          </div>
        ) : (
          <div className="col" style={{ alignItems: 'center' }}>
            <Spinner size={22} />
            <span className="faint small">studio-daw reads the song…</span>
          </div>
        )}
      </div>
    );
  }

  const insts = Object.keys(model.instruments);
  const step = track?.form === 'grid' ? (parseDuration(String(track.opts.step ?? 's'), barLen) ?? 0.25) : 0.25;
  const chordText = track?.form === 'chords' ? String((rawTrack as Record<string, unknown>)?.chords ?? '') : '';
  // the track as notation text; several voices = one paragraph each
  const voiceList = Array.isArray(rawTrack) && rawTrack.every((v) => typeof v === 'string') ? (rawTrack as string[]) : null;
  const sourceText =
    typeof rawTrack === 'string'
      ? rawTrack
      : voiceList
        ? voiceList.map((v) => v.trim()).join('\n\n')
        : rawTrack && typeof rawTrack === 'object' && !Array.isArray(rawTrack)
          ? String((rawTrack as Record<string, unknown>)[track?.form === 'grid' ? 'grid' : track?.form === 'chords' ? 'chords' : 'notes'] ?? '')
          : '';
  const textEditable = typeof rawTrack === 'string' || !!voiceList || (!!rawTrack && typeof rawTrack === 'object' && !Array.isArray(rawTrack) && track?.form !== 'events');

  return (
    <div
      className={`daw${dropping ? ' dropping' : ''}`}
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKey}
      onKeyUp={onKeyUp}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) releaseTyping();
      }}
      onChange={(e) => {
        // a select keeps the keyboard focus after choosing: give it back so the typing keys play again
        const el = e.target as HTMLElement;
        if (keysOpen && typing && el.tagName === 'SELECT' && e.currentTarget.contains(el)) focusRoot();
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        if (e.dataTransfer.files.length) void openFiles(e.dataTransfer.files);
      }}
    >
      {/* ---- toolbar ---- */}
      <div className="daw-bar">
        <div className="seg tp">
          <button className="btn sm ghost icon" title="To start (Home)" onClick={toStart}>
            <SkipBack size={14} />
          </button>
          <button className="btn sm ghost icon" title="Stop — pressed again: back to the start" onClick={() => (audio.playing ? stop() : toStart())}>
            <Square size={12} fill="currentColor" />
          </button>
          <button className={`btn sm icon ${playing ? 'primary' : ''}`} title="Play / pause (Space)" onClick={toggle}>
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            className={`btn sm ghost icon rec-btn${recording ? ' on' : ''}`}
            title={
              recording
                ? 'Stop recording (R) — the transport keeps running'
                : `Record what you play into ${selTrack ? `"${selTrack}"` : 'the selected track'} of ${selPattern ? `"${selPattern}"` : 'the pattern'} (R) — MIDI keyboard, on-screen keyboard or computer keys`
            }
            onClick={() => void record()}
          >
            <Circle size={13} fill="currentColor" />
          </button>
        </div>
        <div className="seg">
          <button
            className={`btn sm ghost icon${scope === 'pattern' || loopOn ? ' on' : ''}`}
            title={scope === 'pattern' ? 'Pattern mode always loops the pattern' : loop ? 'Loop the marked range (L)' : 'Loop: drag on the ruler of the arrangement to mark a range'}
            onClick={() => setLoopOn((v) => !v)}
            disabled={scope === 'pattern' || !loop}
          >
            <Repeat size={14} />
          </button>
          <button className={`btn sm ghost icon${metro ? ' on' : ''}`} title="Metronome (M)" onClick={() => setMetro((v) => !v)}>
            <Metronome size={14} />
          </button>
          <button
            className={`btn sm ghost countin${countIn ? ' on' : ''}`}
            title={`Count-in before a recording starts: ${countIn ? `${countIn} bar${countIn > 1 ? 's' : ''} of clicks` : 'off'} — click to change (off · 1 bar · 2 bars)`}
            onClick={() => setCountIn((countIn + 1) % 3)}
          >
            <Timer size={14} />
            <span className="mono">{countIn || '–'}</span>
          </button>
          <button className={`btn sm ghost icon${follow ? ' on' : ''}`} title="Follow the playhead: the editors scroll along while the song plays" onClick={() => setFollow((v) => !v)}>
            <LocateFixed size={14} />
          </button>
        </div>
        <Lcd model={playModel ?? model} audio={audio} recording={recording} />
        <div className="seg tempo">
          <NumField value={model.song.bpm} min={20} max={400} width={50} title="Tempo in beats per minute" onChange={(v) => v && apply((d, m) => ops.setSongField(d, m, 'bpm', v))} />
          <span className="small faint">bpm</span>
          <TapTempo onTempo={(v) => apply((d, m) => ops.setSongField(d, m, 'bpm', v), 'song:bpm:tap')} />
          <button className="btn sm ghost sig mono" title="Time signature — change it on the Song tab" onClick={() => setTab('song')}>
            {model.song.time}
          </button>
        </div>
        <select
          className="daw-input rec-q"
          value={recQ}
          title="Input quantize: recorded notes snap to this grid (off = exact timing, written as exact events; drum grids always snap to their step)"
          onChange={(e) => {
            setRecQ(Number(e.target.value));
            focusRoot();
          }}
        >
          {REC_QUANT.map((q) => (
            <option key={q.label} value={q.value}>
              Q {q.label}
            </option>
          ))}
        </select>
        <div className="seg" title="Song: the transport plays the arrangement · Pattern: it loops the selected pattern alone (handy for recording and editing)">
          <button className={`btn sm ${scope === 'song' ? 'primary' : 'ghost'}`} onClick={() => switchScope('song')}>
            Song
          </button>
          <button className={`btn sm ${scope === 'pattern' ? 'primary' : 'ghost'}`} disabled={!selPattern} onClick={() => switchScope('pattern')}>
            Pattern
          </button>
        </div>
        <div className="seg" title="Live: instant, approximated effects · Rendered: the exact render of the engine">
          <button className={`btn sm ${mode === 'live' ? 'primary' : 'ghost'}`} onClick={() => (stop(), setMode('live'))}>
            Live
          </button>
          <button className={`btn sm ${mode === 'rendered' ? 'primary' : 'ghost'}`} disabled={!rendered} onClick={() => (stop(), switchScope('song'), setMode('rendered'))}>
            Rendered{renderStale ? ' *' : ''}
          </button>
        </div>
        <button className="btn sm" onClick={() => void render()} disabled={rendering} title="Render exactly with studio-daw (all effects and plugins, humanize, mastering) and listen">
          {rendering ? <Spinner size={13} /> : <Sparkles size={13} />} Render
        </button>
        {renderStale && mode === 'rendered' && <span className="badge warn" title="The song changed since this render">outdated</span>}
        {audio.bank.busy > 0 && (
          <span className="small faint row" style={{ gap: 4 }} title="The engine renders the instruments' sounds (cached afterwards)">
            <Spinner size={12} /> sounds
          </span>
        )}
        {syncing && <Spinner size={12} />}
        <span className="spacer" />
        <MidiMenu midi={midi} onPanic={panic} onFocusBack={focusRoot} />
        <button
          className={`btn sm ghost icon${keysOpen ? ' on' : ''}`}
          title="Keyboard: play the selected track with the mouse or the computer keyboard"
          onClick={() => {
            setKeysOpen((v) => !v);
            focusRoot();
          }}
        >
          <Piano size={14} />
        </button>
        <button className="btn sm ghost icon" title="Undo (Ctrl+Z)" disabled={!hist.undo} onClick={undo}>
          <Undo2 size={14} />
        </button>
        <button className="btn sm ghost icon" title="Redo (Ctrl+Shift+Z)" disabled={!hist.redo} onClick={redo}>
          <Redo2 size={14} />
        </button>
        <div className="row" style={{ gap: 4 }} title="Speaker volume">
          <Volume2 size={14} className="faint" />
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={monitor}
            style={{ width: 70 }}
            onChange={(e) => {
              const v = Number(e.target.value);
              setMonitor(v);
              audio.setVolume(v);
            }}
          />
        </div>
        <button
          className="btn sm ghost"
          onClick={(e) =>
            setMenu({
              x: e.clientX,
              y: e.clientY + 12,
              items: [
                { label: 'Open song or MIDI file… (new tab)', icon: <FolderOpen size={14} />, onClick: () => fileInput.current?.click() },
                { label: 'Load a file into this song…', icon: <FileMusic size={14} />, onClick: () => replaceInput.current?.click() },
                { label: 'New song…', icon: <Plus size={14} />, onClick: () => void newSong() },
              ],
            })
          }
        >
          <FolderOpen size={14} /> Open
        </button>
        <button className="btn sm primary" onClick={() => setExportOpen(true)} title="MIDI, WAV, MP3, stems, or everything as one zip">
          <Download size={14} /> Export
        </button>
        <button className="btn sm ghost icon" title="Keyboard shortcuts (?)" onClick={() => setHelp(true)}>
          <CircleQuestionMark size={14} />
        </button>
        <input ref={fileInput} type="file" hidden multiple accept=".yaml,.yml,.mid,.midi" onChange={(e) => (e.target.files && void openFiles(e.target.files), (e.target.value = ''))} />
        <input ref={replaceInput} type="file" hidden accept=".yaml,.yml" onChange={(e) => (e.target.files?.[0] && void replaceWith(e.target.files[0]), (e.target.value = ''))} />
      </div>

      {(engineError || model.pluginErrors.length > 0 || bankErrors.size > 0) && (
        <div className="daw-banners">
          {engineError && (
            <div className="notice error small">
              <AlertTriangle size={14} />
              <div className="grow">
                <b>The engine cannot read the current text</b> — showing the last working state. <span className="mono">{engineError}</span>
              </div>
            </div>
          )}
          {model.pluginErrors.map((e) => (
            <div key={e.file} className="notice warn small">
              <AlertTriangle size={14} />
              <div className="grow">
                Plugin <button className="link-btn mono" onClick={() => onOpenFile?.(e.file)}>{e.file}</button> failed to load: <span className="mono">{e.error}</span>
              </div>
            </div>
          ))}
          {[...bankErrors].slice(0, 3).map(([inst, msg]) => (
            <div key={inst} className="notice warn small">
              <AlertTriangle size={14} />
              <div className="grow">
                No sound for <b>{inst}</b>: <span className="mono">{msg.slice(0, 300)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- arrangement ---- */}
      <div className="daw-arr" style={{ height: arrH }}>
        <Arrangement
          model={model}
          selPattern={selPattern}
          selSection={selSection}
          loop={loop}
          loopOn={loopOn}
          position={position}
          onSelectPattern={(p) => setSelPattern(p)}
          onEditPattern={editPattern}
          onSelectSection={setSelSection}
          onToggle={(i, p) => apply((d, m) => ops.togglePlay(d, m, i, p))}
          onClipMenu={(i, entry, x, y) =>
            setMenu({
              x,
              y,
              items: [
                { label: 'Edit pattern', onClick: () => editPattern(entry.pattern) },
                { label: 'Options (transpose, velocity …)', onClick: () => setPlayOpts({ i, entry }) },
                { label: 'Remove from section', danger: true, onClick: () => apply((d, m) => ops.togglePlay(d, m, i, entry.pattern)) },
              ],
            })
          }
          onPatternMenu={patternMenu}
          onSeek={seekSong}
          onLoop={(a, b) => {
            setLoop({ a, b });
            setLoopOn(true);
          }}
          onSection={(i, field, value) => apply((d, m) => ops.setSectionField(d, m, i, field, value), `sec:${i}:${field}`)}
          onSectionAction={sectionAction}
          onAddPattern={() => void newPattern()}
          follow={follow}
          playing={playing}
          showHead={scope === 'song'}
        />
      </div>
      <div
        className="daw-split"
        onPointerDown={(e) => {
          const y0 = e.clientY;
          const h0 = arrH;
          const move = (ev: PointerEvent) => setArrH(Math.max(90, Math.min(window.innerHeight - 240, h0 + ev.clientY - y0)));
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
      />

      {/* ---- bottom panel ---- */}
      <div className="daw-bottom">
        <div className="daw-tabs">
          {(['pattern', 'mixer', 'instruments', 'song'] as Tab[]).map((t) => (
            <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {t === 'pattern' ? `Pattern${selPattern ? ` · ${selPattern}` : ''}` : t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div className="daw-panel">
          {tab === 'pattern' && pattern && selPattern && (
            <div className="pat">
              <div className="pat-head">
                <select className="daw-input" value={selPattern} onChange={(e) => setSelPattern(e.target.value)} title="Pattern">
                  {Object.keys(model.patterns).map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
                <button className="btn sm ghost" onClick={() => void patternBars(selPattern)} title="Pattern length">
                  {Math.round((pattern.length / barLen) * 100) / 100} bar{pattern.length === barLen ? '' : 's'}
                  {pattern.bars ? '' : ' (auto)'}
                </button>
                {recording && (
                  <span className="badge danger rec-badge" title="Notes you play are written into this track — Stop or R ends the take, one Undo removes it">
                    ● REC {selTrack}
                  </span>
                )}
                {scope === 'pattern' && (
                  <span className="badge accent" title="The transport loops this pattern alone. The Song button in the toolbar switches back to the arrangement.">
                    pattern mode
                  </span>
                )}
                <span className="spacer" />
                {track?.form === 'chords' && (
                  <div className="row" style={{ gap: 4 }} title="Chord symbols, one bar each unless a length is given (Am7:2)">
                    <span className="small faint">chords</span>
                    <TextField mono width={260} value={chordText} onChange={(v) => apply((d) => ({ doc: d.set(['patterns', selPattern, selTrack!, 'chords'], v) }))} />
                  </div>
                )}
                <button className={`btn sm ghost${showText ? ' on' : ''}`} onClick={() => setShowText((v) => !v)} title="Show the notation text of this track">
                  Text
                </button>
              </div>
              {showText && track && selTrack && (
                <TrackText
                  key={`${selPattern}/${selTrack}`}
                  value={sourceText}
                  editable={textEditable}
                  onChange={(v) => {
                    const raw = rawTrack;
                    if (typeof raw === 'string' || voiceList) {
                      // notes text: a blank line starts another voice (notes that overlap)
                      const voices = track.form === 'grid' ? [v] : v.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
                      apply((d) => ({ doc: d.set(['patterns', selPattern, selTrack], voices.length > 1 ? voices : (voices[0] ?? '')) }));
                    } else apply((d) => ({ doc: d.set(['patterns', selPattern, selTrack, track.form === 'grid' ? 'grid' : track.form === 'chords' ? 'chords' : 'notes'], v) }));
                  }}
                />
              )}
              <div className="pat-body">
                <TrackList
                  model={model}
                  pattern={pattern}
                  patternName={selPattern}
                  sel={selTrack}
                  recording={recording}
                  audio={audio}
                  onSelect={setSelTrack}
                  onMix={(inst, key, on) => apply((d, m) => ops.setMix(d, m, inst, key, on || undefined))}
                  onRemove={async (t) => {
                    if (await ui.confirm({ title: `Remove ${t} from ${selPattern}?`, confirm: 'Remove', danger: true })) apply((d, m) => ops.removeTrack(d, m, selPattern, t));
                  }}
                  onAdd={(inst) => {
                    if (apply((d, m) => ops.addTrack(d, m, selPattern, inst))) setSelTrack(inst);
                    focusRoot();
                  }}
                />
                <div className="pat-editor">
                  {track && selTrack && ins ? (
                    track.form === 'grid' ? (
                      <StepGrid
                        key={`${selPattern}/${selTrack}`}
                        events={track.events}
                        rows={gridRows(gridText)}
                        sounds={ins.sounds ?? catalog?.gmKitRows ?? []}
                        length={pattern.length}
                        barLen={barLen}
                        beatLen={beatLen}
                        step={step}
                        gate={Number(track.opts.gate ?? 0.9)}
                        onChange={(evs, rows) => writeEvents(evs, rows)}
                        onStep={(tok) => apply((d, m) => ops.setTrackOption(d, m, selPattern, selTrack, 'step', tok === 's' && !('step' in track.opts) ? undefined : tok))}
                        onAudition={(k, v) => audition(selTrack, { k, v })}
                        playhead={patternPlayhead}
                        follow={follow}
                      />
                    ) : (
                      <PianoRoll
                        key={`${selPattern}/${selTrack}`}
                        events={track.events.filter((e) => e.p !== undefined)}
                        length={pattern.length}
                        barLen={barLen}
                        beatLen={beatLen}
                        gate={track.form === 'chords' ? Number(track.opts.gate ?? 0.98) : Number(track.opts.gate ?? ins.gate)}
                        defaultVel={Number(track.opts.velocity ?? (track.form === 'chords' ? 0.62 : 0.72))}
                        onChange={(evs) => writeEvents(evs)}
                        onAudition={(p, v, l) => audition(selTrack, { p, v, d: (l * 60) / model.song.bpm })}
                        playhead={patternPlayhead}
                        ghost={Object.entries(pattern.tracks)
                          .filter(([k]) => k !== selTrack)
                          .flatMap(([, t]) => t.events)}
                        chordsHint={track.form === 'chords' ? 'chord track — drawing notes turns it into notes if they are no chords any more' : null}
                        follow={follow}
                        live={live}
                        onKey={(pitch, down) => (down ? live.pitchOn(pitch, kbVel) : live.pitchOff(pitch))}
                      />
                    )
                  ) : (
                    <div className="faint small" style={{ padding: 16 }}>
                      Choose a track.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          {tab === 'mixer' && (
            <Mixer
              model={model}
              catalog={catalog}
              audio={audio}
              selInst={selInst}
              onSelectInst={(n) => {
                setSelInst(n);
                setTab('instruments');
              }}
              onMix={(inst, key, value, done) => apply((d, m) => ops.setMix(d, m, inst, key, value), done ? undefined : `mix:${inst}:${key}`)}
              onMaster={(key, value) => apply((d, m) => ops.setMaster(d, m, key, value))}
              onFxAdd={(t, use) => {
                const fx: { use: string; [k: string]: unknown } = { use };
                if (use === 'sidechain') fx.source = insts.find((n) => model.instruments[n].drum) ?? insts[0];
                apply((d, m) => ops.addEffect(d, m, t, fx));
              }}
              onFxRemove={(t, i) => apply((d, m) => ops.removeEffect(d, m, t, i))}
              onFxMove={(t, a, b) => apply((d, m) => ops.moveEffect(d, m, t, a, b))}
              onFxParam={(t, i, key, value, done) => apply((d, m) => ops.setEffectParam(d, m, t, i, key, value), done ? undefined : `fx:${JSON.stringify(t)}:${i}:${key}`)}
              monitor={monitor}
              onMonitor={(v) => {
                setMonitor(v);
                audio.setVolume(v);
              }}
            />
          )}
          {tab === 'instruments' && (
            <InstrumentsPanel
              model={model}
              catalog={catalog}
              rawSpec={(n) => doc.get(['instruments', n])}
              sel={selInst}
              soundErrors={bankErrors}
              onSelect={setSelInst}
              onParam={(n, key, value, done) => apply((d, m) => ops.setInstrumentParam(d, m, n, key, value), done ? undefined : `param:${n}:${key}`)}
              onSpec={(n, spec) => apply((d) => ops.setInstrumentSpec(d, n, spec))}
              onRename={async (n) => {
                const to = await ui.prompt('Rename instrument', n);
                if (to && to !== n && apply((d, m) => ops.renameInstrument(d, m, n, to))) {
                  setSelInst(to.trim());
                  if (selTrack === n) setSelTrack(to.trim());
                }
              }}
              onDelete={async (n) => {
                if (await ui.confirm({ title: `Delete instrument ${n}?`, body: 'Its tracks in all patterns are removed too (patterns left empty are deleted).', confirm: 'Delete', danger: true }))
                  apply((d, m) => ops.deleteInstrument(d, m, n));
              }}
              onAdd={() => setAddInst(true)}
              onAudition={(n, x) => audition(n, x)}
              onOpenFile={onOpenFile}
            />
          )}
          {tab === 'song' && <SongPanel model={model} onSong={(key, value) => apply((d, m) => ops.setSongField(d, m, key, value), `song:${key}`)} />}
        </div>
      </div>

      {keysOpen && (
        <KeyboardPanel
          live={live}
          target={target}
          octave={kbOct}
          onOctave={setKbOct}
          velocity={kbVel}
          onVelocity={setKbVel}
          typing={typing}
          onTyping={(on) => {
            setTyping(on);
            focusRoot();
          }}
          labels={labels}
          recording={recording}
          onClose={() => setKeysOpen(false)}
        />
      )}

      {help && <ShortcutsDialog labels={labels} onClose={() => setHelp(false)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {exportOpen && (
        <ExportDialog
          base={base}
          model={model}
          loop={loop}
          run={runExport}
          onDownload={download}
          onDownloadYaml={downloadYaml}
          onClose={() => setExportOpen(false)}
        />
      )}
      {midiImport && (
        <MidiImportDialog
          file={midiImport}
          catalog={catalog}
          onClose={() => setMidiImport(null)}
          onDone={async (songText) => {
            const target = await freeName(songDir, midiImport.name);
            try {
              await api(`/projects/${projectId}/file`, { method: 'PUT', body: { path: target, content: songText } });
              setMidiImport(null);
              ui.toast(`Imported ${midiImport.name} → ${target}`);
              onOpenFile?.(target);
            } catch (err) {
              ui.toast(errMsg(err), 'error');
            }
          }}
        />
      )}
      {playOpts && (
        <PlayOptsDialog
          entry={playOpts.entry}
          model={model}
          onClose={() => setPlayOpts(null)}
          onSave={(o) => {
            apply((d, m) => ops.setPlayOpts(d, m, playOpts.i, playOpts.entry.pattern, o));
            setPlayOpts(null);
          }}
        />
      )}
      {addInst && (
        <SoundPicker
          catalog={catalog}
          title="Add an instrument"
          onClose={() => setAddInst(false)}
          onPick={async (c) => {
            setAddInst(false);
            let n = c.use.split('/').pop()!.replace(/[^A-Za-z0-9_]+/g, '_').slice(0, 20) || 'inst';
            for (let i = 2; modelRef.current?.instruments[n]; i++) n = `${n.replace(/\d+$/, '')}${i}`;
            const name = await ui.prompt('Instrument name', n);
            if (name && apply((d) => ops.addInstrument(d, name, specForUse({}, c)))) {
              setSelInst(name.trim());
              setTab('instruments');
            }
          }}
        />
      )}
    </div>
  );
}

function TrackText({ value, editable, onChange }: { value: string; editable: boolean; onChange: (v: string) => void }) {
  const [s, setS] = useState(value);
  useEffect(() => setS(value), [value]);
  return (
    <div className="track-text">
      <textarea
        className="textarea mono"
        value={s}
        readOnly={!editable}
        spellCheck={false}
        rows={Math.min(8, Math.max(2, s.split('\n').length))}
        onChange={(e) => setS(e.target.value)}
        onBlur={() => s !== value && editable && onChange(s)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur();
          e.stopPropagation();
        }}
        title={editable ? 'studio-daw notation — a blank line starts another voice; Ctrl+Enter or click outside applies it' : 'exact events: edit them in the Code view'}
      />
    </div>
  );
}

function PlayOptsDialog({ entry, model, onClose, onSave }: { entry: PlayEntry; model: SongModel; onClose: () => void; onSave: (o: Record<string, unknown>) => void }) {
  const [o, setO] = useState<Record<string, unknown>>({ ...entry.opts });
  const tracks = Object.keys(model.patterns[entry.pattern]?.tracks ?? {});
  const only = Array.isArray(o.only) ? (o.only as string[]) : typeof o.only === 'string' ? [o.only] : [];
  return (
    <Modal
      title={`${entry.pattern} in this section`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave(o)}>
            Apply
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>Transpose (semitones)</label>
        <NumField value={o.transpose as number | undefined} min={-48} max={48} onChange={(v) => setO({ ...o, transpose: v || undefined })} />
        <label>Velocity (×)</label>
        <NumField value={o.velocity as number | undefined} min={0} max={2} onChange={(v) => setO({ ...o, velocity: v })} placeholder="1" />
        <label>Start after (bars)</label>
        <NumField value={o.offset as number | undefined} min={0} max={512} onChange={(v) => setO({ ...o, offset: v || undefined })} placeholder="0" />
        <label>Loop length (bars)</label>
        <NumField value={o.bars as number | undefined} min={0.25} max={512} onChange={(v) => setO({ ...o, bars: v })} placeholder="pattern length" />
        <label>Only these instruments</label>
        <div className="row wrap">
          {tracks.map((t) => (
            <label key={t} className="row small" style={{ gap: 4 }}>
              <input
                type="checkbox"
                checked={only.includes(t)}
                onChange={(e) => {
                  const n = e.target.checked ? [...only, t] : only.filter((x) => x !== t);
                  setO({ ...o, only: n.length ? n : undefined });
                }}
              />
              {t}
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function ExportDialog({
  base,
  model,
  loop,
  run,
  onDownload,
  onDownloadYaml,
  onClose,
}: {
  base: string;
  model: SongModel;
  loop: { a: number; b: number } | null;
  run: (b: { what: string[]; zip?: boolean; from?: number; to?: number; name?: string }) => Promise<ExportResult | null>;
  onDownload: (rel: string) => void;
  onDownloadYaml: () => void;
  onClose: () => void;
}) {
  const [what, setWhat] = useState<Record<string, boolean>>({ wav: true, mp3: true, midi: true, stems: false });
  const [zip, setZip] = useState(true);
  const [range, setRange] = useState<'all' | 'loop'>('all');
  const [name, setName] = useState(base);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const bars = loop ? [Math.floor(secToQ(model, loop.a) / model.song.barLen + 1e-6) + 1, Math.round(secToQ(model, loop.b) / model.song.barLen)] : null;
  const kinds = Object.entries(what)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const go = async (preset?: { what: string[]; zip?: boolean }) => {
    setBusy(true);
    setResult(null);
    const r = await run({
      what: preset?.what ?? kinds,
      zip: preset ? !!preset.zip : zip,
      name: name.trim() || base,
      ...(range === 'loop' && bars ? { from: bars[0], to: bars[1] } : {}),
    });
    setBusy(false);
    if (!r) return;
    setResult(r);
    const f = r.files;
    if (f.zip) onDownload(f.zip);
    else {
      const list = preset?.what ?? kinds;
      if (list.length === 1) {
        const k = list[0];
        if (k === 'stems' && f.stems) onDownload(f.stems);
        else if (f[k]) onDownload(f[k]);
      }
    }
  };
  const labels: Record<string, string> = { wav: 'WAV (mixdown, 24 bit)', mp3: 'MP3 (mixdown)', midi: 'MIDI (all tracks, tempo map, GM programs)', stems: 'Stems (one WAV per instrument)' };
  return (
    <Modal title="Export" onClose={onClose} size="medium">
      <div className="row wrap" style={{ gap: 8, marginBottom: 14 }}>
        <button className="btn sm" disabled={busy} onClick={() => void go({ what: ['midi'] })}>
          MIDI only
        </button>
        <button className="btn sm" disabled={busy} onClick={() => void go({ what: ['wav'] })}>
          WAV only
        </button>
        <button className="btn sm" disabled={busy} onClick={() => void go({ what: ['mp3'] })}>
          MP3 only
        </button>
        <button className="btn sm" disabled={busy} onClick={onDownloadYaml}>
          Song file (.yaml)
        </button>
      </div>
      <div className="col" style={{ gap: 6 }}>
        {Object.keys(labels).map((k) => (
          <label key={k} className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={what[k]} onChange={(e) => setWhat({ ...what, [k]: e.target.checked })} /> {labels[k]}
          </label>
        ))}
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={zip} onChange={(e) => setZip(e.target.checked)} /> One zip with everything + the song file (+ the plugins and samples it uses)
        </label>
      </div>
      <div className="form-grid" style={{ marginTop: 14 }}>
        <label>Range</label>
        <select className="daw-input" value={range} onChange={(e) => setRange(e.target.value as 'all' | 'loop')} style={{ width: 220 }}>
          <option value="all">whole song</option>
          <option value="loop" disabled={!bars}>
            {bars ? `loop range (bars ${bars[0]}–${bars[1]})` : 'loop range (mark one on the ruler)'}
          </option>
        </select>
        <label>File name</label>
        <TextField value={name} width={220} onChange={setName} />
      </div>
      <div className="row" style={{ marginTop: 16, gap: 10 }}>
        <button className="btn primary" disabled={busy || !kinds.length} onClick={() => void go()}>
          {busy ? <Spinner size={14} /> : <Download size={14} />} Export {zip ? 'zip' : kinds.join(' + ')}
        </button>
        {busy && <span className="small faint">studio-daw renders… (long songs take a while)</span>}
      </div>
      {result && (
        <div className="notice ok small" style={{ marginTop: 14, display: 'block' }}>
          <b>
            Exported to exports/{result.seconds !== undefined ? ` · ${result.seconds}s · ${result.lufs} LUFS · peak ${result.peak_dbfs} dBFS` : ''}
          </b>
          <div className="col" style={{ gap: 2, marginTop: 6 }}>
            {Object.entries(result.files)
              .filter(([k]) => k !== 'preview')
              .map(([k, f]) => (
                <button key={k} className="link-btn mono" style={{ textAlign: 'left' }} onClick={() => onDownload(f)}>
                  ⬇ {f}
                </button>
              ))}
          </div>
          {result.warnings.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--warn)' }}>
              {result.warnings.slice(0, 8).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
