import { Copy, MousePointer2, Pencil, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { NumField } from './controls';
import type { LivePlayer } from './live';
import { CHORD_QUALITIES, isBlackKey, midiName, SNAPS } from './notation';
import type { DawEvent } from './types';

/** Pointer capture that tolerates pointers the browser does not track (pen/touch edge cases, synthetic events). */
function capture(e: React.PointerEvent): void {
  try {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  } catch {
    /* not capturable */
  }
}

const ROW = 12;
const KEYS_W = 46;
const VEL_H = 54;
const sig = (e: DawEvent) => `${Math.round(e.t * 1e4)}|${e.p}`;

// scales to highlight in the grid (semitones above the root)
const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  'harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  'major pentatonic': [0, 2, 4, 7, 9],
  'minor pentatonic': [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
};
const ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** The major or minor key that fits the notes best ("9:minor" = A minor), or null with too few notes. */
function detectScale(notes: DawEvent[]): string | null {
  const hist = new Array<number>(12).fill(0);
  let n = 0;
  for (const e of notes) {
    if (e.p === undefined) continue;
    hist[((e.p % 12) + 12) % 12] += Math.max(0.1, e.l);
    n++;
  }
  if (n < 4) return null;
  // the lowest note at the very start is usually the root of the first chord — often the key
  const pitched = notes.filter((e) => e.p !== undefined);
  const t0 = Math.min(...pitched.map((e) => e.t));
  const first = Math.min(...pitched.filter((e) => e.t - t0 < 1e-6).map((e) => e.p as number)) % 12;
  const total = hist.reduce((a, b) => a + b, 0);
  let best = '';
  let bestScore = -1;
  for (const mode of ['major', 'minor']) {
    for (let root = 0; root < 12; root++) {
      // notes inside the scale count; the root, its fifth and the opening note tell relative major and minor apart
      const score =
        SCALES[mode].reduce((a, i) => a + hist[(root + i) % 12], 0) + 0.6 * hist[root] + 0.25 * hist[(root + 7) % 12] + (root === first ? 0.12 * total : 0);
      if (score > bestScore + 1e-9) {
        bestScore = score;
        best = `${root}:${mode}`;
      }
    }
  }
  return best;
}
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

interface Props {
  events: DawEvent[];
  length: number;
  barLen: number;
  beatLen: number;
  gate: number;
  defaultVel: number;
  onChange: (events: DawEvent[]) => void;
  onAudition: (p: number, v: number, l: number) => void;
  /** beat position inside this pattern while playing (or null) */
  playhead?: () => number | null;
  ghost?: DawEvent[];
  chordsHint?: string | null;
  /** keep the playhead in view while playing */
  follow?: boolean;
  /** live input of this track: its sounding notes light up the keys on the left */
  live?: LivePlayer | null;
  /** the keys on the left play live (held as long as the mouse is down) instead of a short preview */
  onKey?: (p: number, down: boolean) => void;
}

type Drag =
  | { mode: 'move'; x: number; y: number; orig: DawEvent[]; ids: Set<string>; copy: boolean; anchor: DawEvent; moved?: DawEvent[]; lastP?: number }
  | { mode: 'resize'; x: number; orig: DawEvent[]; ids: Set<string>; anchor: DawEvent }
  | { mode: 'box'; x: number; y: number; x2: number; y2: number; base: Set<string> }
  | { mode: 'vel'; orig: DawEvent[] };

export function PianoRoll({ events, length, barLen, beatLen, gate, defaultVel, onChange, onAudition, playhead, ghost, chordsHint, follow, live, onKey: onLiveKey }: Props) {
  const [ppb, setPpb] = useState(44);
  const [snap, setSnap] = useState(0.25);
  const [tool, setTool] = useState<'draw' | 'select'>('draw');
  const [chord, setChord] = useState('');
  // 'off' | 'auto' | '<root 0-11>:<scale>'
  const [scale, setScaleState] = useState<string>(() => {
    try {
      return localStorage.getItem('daw.scale') ?? 'auto';
    } catch {
      return 'auto';
    }
  });
  const setScale = (v: string) => {
    setScaleState(v);
    try {
      localStorage.setItem('daw.scale', v);
    } catch {
      /* private mode */
    }
  };
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [preview, setPreview] = useState<DawEvent[] | null>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const lastLen = useRef(1);
  const drag = useRef<Drag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const velScroller = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const keysEl = useRef<HTMLDivElement>(null);
  const clip = useRef<DawEvent[]>([]);
  const userScroll = useRef(0);
  const keyDown = useRef<number | null>(null);

  const shown = preview ?? events;
  const total = Math.max(length, ...shown.map((e) => e.t + e.l)) + barLen;
  const width = Math.ceil(total / barLen) * barLen * ppb;
  const height = 128 * ROW;
  const snapV = snap === -1 ? barLen : snap;

  const qt = useCallback((t: number, mode: 'round' | 'floor' = 'round') => {
    if (!snapV) return r6(Math.round(t * 960) / 960);
    const f = mode === 'floor' ? Math.floor(t / snapV + 1e-9) : Math.round(t / snapV);
    return r6(f * snapV);
  }, [snapV]);

  // keep the selection on the same notes when the engine re-sends events
  useEffect(() => {
    setSel((s) => {
      const have = new Set(events.map(sig));
      const n = new Set([...s].filter((x) => have.has(x)));
      return n.size === s.size ? s : n;
    });
  }, [events]);

  // scroll to the notes (or middle C) when the track changes
  const firstScroll = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !firstScroll.current) return;
    firstScroll.current = false;
    const ps = events.map((e) => e.p ?? 60);
    const mid = ps.length ? (Math.min(...ps) + Math.max(...ps)) / 2 : 60;
    el.scrollTop = Math.max(0, (127 - mid) * ROW - el.clientHeight / 2);
  }, [events]);

  // playhead
  useEffect(() => {
    if (!playhead) return;
    let raf = 0;
    const loop = () => {
      const q = playhead();
      if (head.current) {
        head.current.style.display = q === null ? 'none' : 'block';
        if (q !== null) head.current.style.transform = `translateX(${KEYS_W + q * ppb}px)`;
      }
      // follow: turn the page when the playhead leaves the view (not while the user scrolls or drags)
      const el = scroller.current;
      if (follow && q !== null && el && !drag.current && performance.now() - userScroll.current > 2500) {
        const x = q * ppb;
        const view = el.clientWidth - KEYS_W;
        if (view > 80 && (x < el.scrollLeft || x > el.scrollLeft + view - 24)) el.scrollLeft = Math.max(0, x - view * 0.1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playhead, ppb, follow]);

  // keys of the notes sounding live (MIDI keyboard, on-screen keys, computer keyboard)
  useEffect(() => {
    const box = keysEl.current;
    if (!live || !box) return;
    const paint = () => {
      const on = new Set(live.notes());
      box.querySelectorAll<HTMLElement>('.pr-key.live').forEach((k) => {
        if (!on.has(Number(k.dataset.p))) k.classList.remove('live');
      });
      for (const p of on) box.querySelector<HTMLElement>(`.pr-key[data-p="${p}"]`)?.classList.add('live');
    };
    paint();
    const off = live.subscribe(paint);
    return () => {
      off();
      box.querySelectorAll('.pr-key.live').forEach((k) => k.classList.remove('live'));
    };
  }, [live]);

  // Ctrl+wheel zooms around the mouse (native, non-passive listener: the page must not zoom)
  const ppbRef = useRef(ppb);
  ppbRef.current = ppb;
  const zoomAt = useRef<{ t: number; x: number } | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const fn = (ev: WheelEvent) => {
      userScroll.current = performance.now();
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      const x = ev.clientX - el.getBoundingClientRect().left - KEYS_W;
      zoomAt.current = { t: (el.scrollLeft + x) / ppbRef.current, x };
      setPpb((z) => Math.min(240, Math.max(10, z * (ev.deltaY < 0 ? 1.2 : 1 / 1.2))));
    };
    el.addEventListener('wheel', fn, { passive: false });
    return () => el.removeEventListener('wheel', fn);
  }, []);
  useLayoutEffect(() => {
    const z = zoomAt.current;
    const el = scroller.current;
    zoomAt.current = null;
    if (z && el) el.scrollLeft = Math.max(0, z.t * ppb - z.x);
  }, [ppb]);

  // a key of the left keyboard held with the mouse ends when the editor goes away
  const liveKeyRef = useRef(onLiveKey);
  liveKeyRef.current = onLiveKey;
  useEffect(
    () => () => {
      if (keyDown.current !== null) liveKeyRef.current?.(keyDown.current, false);
    },
    [],
  );
  const keyRelease = () => {
    if (keyDown.current === null) return;
    onLiveKey?.(keyDown.current, false);
    keyDown.current = null;
  };
  const keyPress = (p: number, ev: React.PointerEvent) => {
    if (ev.button !== 0) return;
    if (!onLiveKey) {
      onAudition(p, defaultVel, 0.5);
      return;
    }
    capture(ev);
    keyRelease();
    keyDown.current = p;
    onLiveKey(p, true);
  };

  const commit = useCallback(
    (next: DawEvent[], select?: DawEvent[]) => {
      const clean = next
        .filter((e) => e.l > 1e-4 && e.t >= -1e-9 && (e.p ?? 0) >= 0 && (e.p ?? 0) <= 127)
        .map((e) => ({ ...e, t: r6(Math.max(0, e.t)), l: r6(e.l), d: r6(e.d > 0 ? e.d : e.l * (e.s ? 0.5 : gate)) }));
      // drop exact duplicates (same start + pitch)
      const seen = new Set<string>();
      const out = clean.filter((e) => (seen.has(sig(e)) ? false : (seen.add(sig(e)), true)));
      if (select) setSel(new Set(select.map(sig)));
      onChange(out);
    },
    [gate, onChange],
  );

  const pos = (e: React.PointerEvent | React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const hit = (x: number, y: number): DawEvent | null => {
    for (let i = shown.length - 1; i >= 0; i--) {
      const e = shown[i];
      const top = (127 - (e.p ?? 60)) * ROW;
      if (y >= top && y < top + ROW && x >= e.t * ppb && x <= (e.t + e.l) * ppb + 1) return e;
    }
    return null;
  };

  const chordPitches = (root: number) => (chord ? (CHORD_QUALITIES[chord] ?? [0]).map((i) => root + i) : [root]);

  const onDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (ev.button === 1) return;
    capture(ev);
    (ev.currentTarget as HTMLElement).focus();
    const { x, y } = pos(ev);
    const t = x / ppb;
    const p = 127 - Math.floor(y / ROW);
    const h = hit(x, y);
    if (h) {
      if (ev.button === 2) {
        const ids = sel.has(sig(h)) ? sel : new Set([sig(h)]);
        commit(events.filter((e) => !ids.has(sig(e))));
        return;
      }
      let ids = sel;
      if (!sel.has(sig(h))) {
        ids = ev.shiftKey ? new Set([...sel, sig(h)]) : new Set([sig(h)]);
        setSel(ids);
      } else if (ev.shiftKey) {
        const n = new Set(sel);
        n.delete(sig(h));
        setSel(n);
        return;
      }
      const right = (h.t + h.l) * ppb;
      onAudition(h.p ?? 60, h.v, Math.min(h.l, 2));
      if (right - x < Math.min(8, (h.l * ppb) / 3)) drag.current = { mode: 'resize', x, orig: events, ids, anchor: h };
      else drag.current = { mode: 'move', x, y, orig: events, ids, copy: ev.altKey, anchor: h };
      return;
    }
    if (ev.button === 2) return;
    if (tool === 'select' || ev.shiftKey || ev.ctrlKey || ev.metaKey) {
      const base = ev.shiftKey ? new Set(sel) : new Set<string>();
      setSel(base);
      drag.current = { mode: 'box', x, y, x2: x, y2: y, base };
      return;
    }
    // draw a new note (or chord) and drag to set its length
    const start = qt(t, 'floor');
    const len = snapV ? Math.max(snapV, lastLen.current) : lastLen.current;
    const added = chordPitches(p).filter((q) => q >= 0 && q <= 127).map((q) => ({ t: start, l: len, d: len * gate, p: q, v: defaultVel }));
    const next = [...events.filter((e) => !added.some((a) => sig(a) === sig(e))), ...added];
    const ids = new Set(added.map(sig));
    setSel(ids);
    setPreview(next);
    onAudition(p, defaultVel, Math.min(len, 1));
    drag.current = { mode: 'resize', x: (start + len) * ppb, orig: next, ids, anchor: added[0] };
  };

  const onMove = (ev: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const { x, y } = pos(ev);
    if (d.mode === 'move') {
      const dt = qt(d.anchor.t + (x - d.x) / ppb) - d.anchor.t;
      const dp = -Math.round((y - d.y) / ROW);
      const moved = d.orig.filter((e) => d.ids.has(sig(e))).map((e) => ({ ...e, t: Math.max(0, e.t + dt), p: Math.min(127, Math.max(0, (e.p ?? 60) + dp)) }));
      const rest = d.copy ? d.orig : d.orig.filter((e) => !d.ids.has(sig(e)));
      d.moved = moved;
      setPreview([...rest.filter((e) => !moved.some((m) => sig(m) === sig(e))), ...moved]);
      if (moved.length === 1 && d.lastP !== moved[0].p) {
        if (d.lastP !== undefined) onAudition(moved[0].p ?? 60, moved[0].v, 0.3);
        d.lastP = moved[0].p;
      }
    } else if (d.mode === 'resize') {
      const end = qt(d.anchor.t + d.anchor.l + (x - d.x) / ppb);
      const dl = end - (d.anchor.t + d.anchor.l);
      const min = snapV || 1 / 32;
      setPreview(
        d.orig.map((e) => {
          if (!d.ids.has(sig(e))) return e;
          const l = Math.max(min, e.l + dl);
          return { ...e, l, d: l * (e.s ? 0.5 : gate) };
        }),
      );
    } else if (d.mode === 'box') {
      d.x2 = x;
      d.y2 = y;
      const x0 = Math.min(d.x, x);
      const x1 = Math.max(d.x, x);
      const y0 = Math.min(d.y, y);
      const y1 = Math.max(d.y, y);
      setBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      const n = new Set(d.base);
      for (const e of events) {
        const top = (127 - (e.p ?? 60)) * ROW;
        if (e.t * ppb < x1 && (e.t + e.l) * ppb > x0 && top < y1 && top + ROW > y0) n.add(sig(e));
      }
      setSel(n);
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    setBox(null);
    if (!d || d.mode === 'box' || d.mode === 'vel') return;
    const p = preview;
    setPreview(null);
    if (!p) return;
    if (d.mode === 'resize') {
      const a = p.find((e) => d.ids.has(sig(e)));
      if (a) lastLen.current = a.l;
      commit(p, p.filter((e) => d.ids.has(sig(e))));
    } else commit(p, d.moved ?? []);
  };

  // ---- keyboard ----------------------------------------------------------------
  const selected = () => events.filter((e) => sel.has(sig(e)));
  const onKey = (ev: React.KeyboardEvent) => {
    const k = ev.key;
    const mod = ev.ctrlKey || ev.metaKey;
    if (k === 'Delete' || k === 'Backspace') {
      if (!sel.size) return;
      ev.preventDefault();
      ev.stopPropagation();
      commit(events.filter((e) => !sel.has(sig(e))));
    } else if (mod && k.toLowerCase() === 'a') {
      ev.preventDefault();
      ev.stopPropagation();
      setSel(new Set(events.map(sig)));
    } else if (mod && k.toLowerCase() === 'c') {
      clip.current = selected();
      ev.stopPropagation();
    } else if (mod && k.toLowerCase() === 'x') {
      if (!sel.size) return;
      ev.preventDefault();
      ev.stopPropagation();
      clip.current = selected();
      commit(events.filter((e) => !sel.has(sig(e))));
    } else if (!mod && !ev.altKey && k.toLowerCase() === 'q') {
      ev.preventDefault();
      ev.stopPropagation();
      quantize();
    } else if (mod && (k.toLowerCase() === 'v' || k.toLowerCase() === 'd')) {
      ev.preventDefault();
      ev.stopPropagation();
      const src = k.toLowerCase() === 'd' ? selected() : clip.current;
      if (!src.length) return;
      const s0 = Math.min(...src.map((e) => e.t));
      const s1 = Math.max(...src.map((e) => e.t + e.l));
      const span = Math.ceil((s1 - s0) / (snapV || beatLen) - 1e-9) * (snapV || beatLen);
      const offset = k.toLowerCase() === 'd' ? span : Math.max(...events.filter((e) => sel.has(sig(e))).map((e) => e.t + e.l), 0) - s0 || span;
      const added = src.map((e) => ({ ...e, t: r6(e.t + offset) }));
      commit([...events.filter((e) => !added.some((a) => sig(a) === sig(e))), ...added], added);
    } else if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') {
      if (!sel.size) return;
      ev.preventDefault();
      ev.stopPropagation();
      const dp = k === 'ArrowUp' ? (ev.shiftKey ? 12 : 1) : k === 'ArrowDown' ? (ev.shiftKey ? -12 : -1) : 0;
      const dt = k === 'ArrowLeft' ? -(snapV || 0.25) : k === 'ArrowRight' ? snapV || 0.25 : 0;
      const moved = events.map((e) => (sel.has(sig(e)) ? { ...e, p: Math.min(127, Math.max(0, (e.p ?? 60) + dp)), t: Math.max(0, r6(e.t + dt)) } : e));
      commit(moved, moved.filter((_, i) => sel.has(sig(events[i]))));
      const first = moved.find((_, i) => sel.has(sig(events[i])));
      if (first && dp) onAudition(first.p ?? 60, first.v, 0.3);
    } else if (k === 'Escape') setSel(new Set());
  };

  const quantize = () => {
    if (!snapV) return;
    const ids = sel.size ? sel : new Set(events.map(sig));
    const next = events.map((e) => {
      if (!ids.has(sig(e))) return e;
      const l = Math.max(snapV, qt(e.l));
      return { ...e, t: qt(e.t), l, d: l === e.l ? e.d : l * (e.s ? 0.5 : gate) };
    });
    commit(next, next.filter((_, i) => ids.has(sig(events[i]))));
  };
  const selEvents = sel.size ? events.filter((e) => sel.has(sig(e))) : [];
  const selVel = selEvents.length ? Math.round((selEvents.reduce((a, e) => a + e.v, 0) / selEvents.length) * 127) : undefined;
  const setVelocity = (n: number | undefined) => {
    if (n === undefined || !sel.size) return;
    const v = Math.round((Math.min(127, Math.max(1, Math.round(n))) / 127) * 1e4) / 1e4;
    const next = events.map((e) => (sel.has(sig(e)) ? { ...e, v } : e));
    commit(next, next.filter((e) => sel.has(sig(e))));
  };
  const transpose = (n: number) => {
    const ids = sel.size ? sel : new Set(events.map(sig));
    const next = events.map((e) => (ids.has(sig(e)) ? { ...e, p: Math.min(127, Math.max(0, (e.p ?? 60) + n)) } : e));
    commit(next, sel.size ? next.filter((_, i) => ids.has(sig(events[i]))) : undefined);
  };

  // ---- velocity lane ----------------------------------------------------------
  const velAt = (ev: React.PointerEvent<HTMLDivElement>, base: DawEvent[]) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const x = ev.clientX - r.left + (velScroller.current?.scrollLeft ?? 0) - KEYS_W;
    const v = Math.min(1, Math.max(0.02, 1 - (ev.clientY - r.top) / VEL_H));
    const t = x / ppb;
    let changed = false;
    const next = base.map((e) => {
      const near = Math.abs(e.t * ppb - x) < 6 || (e.t <= t && t < e.t + e.l && (!sel.size || sel.has(sig(e))));
      if (!near || (sel.size && !sel.has(sig(e)) && Math.abs(e.t * ppb - x) >= 6)) return e;
      changed = true;
      return { ...e, v: Math.round(v * 100) / 100 };
    });
    return changed ? next : base;
  };

  const ghostShown = useMemo(() => (ghost ?? []).filter((g) => g.p !== undefined).slice(0, 2000), [ghost]);
  // the scale in effect: chosen, or guessed from this pattern and what else plays with it
  const autoScale = useMemo(() => (scale === 'auto' ? detectScale([...events, ...(ghost ?? [])]) : null), [scale, events, ghost]);
  const scaleKey = scale === 'auto' ? autoScale : scale === 'off' ? null : scale;
  const scaleRows = useMemo(() => {
    if (!scaleKey) return null;
    const [r, mode] = scaleKey.split(':');
    const root = Number(r);
    const steps = SCALES[mode];
    if (!steps || !Number.isFinite(root)) return null;
    return { root, set: new Set(steps.map((i) => (root + i) % 12)), label: `${ROOTS[root]} ${mode}` };
  }, [scaleKey]);
  const bars = Math.ceil(total / barLen);

  return (
    <div className="pr">
      <div className="pr-tools">
        <div className="seg">
          <button className={`btn sm ${tool === 'draw' ? 'primary' : 'ghost'}`} title="Draw: click to add, drag to set the length" onClick={() => setTool('draw')}>
            <Pencil size={13} />
          </button>
          <button className={`btn sm ${tool === 'select' ? 'primary' : 'ghost'}`} title="Select: drag a box (also Ctrl+drag in draw mode)" onClick={() => setTool('select')}>
            <MousePointer2 size={13} />
          </button>
        </div>
        <label className="small faint">Snap</label>
        <select className="daw-input" value={snap} onChange={(e) => setSnap(Number(e.target.value))}>
          {SNAPS.map((s) => (
            <option key={s.label} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <label className="small faint">Scale</label>
        <select
          className="daw-input"
          value={scale}
          onChange={(e) => setScale(e.target.value)}
          title="Highlights the notes of a scale in the grid (rows of the scale are tinted, the root is brighter)"
          style={{ maxWidth: 150 }}
        >
          <option value="off">off</option>
          <option value="auto">{scale === 'auto' && scaleRows ? `auto: ${scaleRows.label}` : 'auto'}</option>
          {Object.keys(SCALES).map((mode) => (
            <optgroup key={mode} label={mode}>
              {ROOTS.map((r, i) => (
                <option key={r} value={`${i}:${mode}`}>
                  {r} {mode}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <label className="small faint">Chord</label>
        <select className="daw-input" value={chord} onChange={(e) => setChord(e.target.value)} title="Draw whole chords with one click">
          <option value="">single note</option>
          {['', 'm', '7', 'maj7', 'm7', 'sus2', 'sus4', 'dim', 'aug', '6', 'm6', '9', 'add9', '5'].map((q) => (
            <option key={q || 'maj'} value={q || 'maj'}>
              {q || 'major'}
            </option>
          ))}
        </select>
        <button className="btn sm ghost" onClick={() => transpose(-12)} title="Octave down (selection or all)">
          −8va
        </button>
        <button className="btn sm ghost" onClick={() => transpose(-1)} title="Semitone down">
          −1
        </button>
        <button className="btn sm ghost" onClick={() => transpose(1)} title="Semitone up">
          +1
        </button>
        <button className="btn sm ghost" onClick={() => transpose(12)} title="Octave up">
          +8va
        </button>
        <button className="btn sm ghost" onClick={quantize} disabled={!snapV} title="Snap starts and lengths to the grid (selection or all) — Q">
          Quantize
        </button>
        {selVel !== undefined && (
          <>
            <label className="small faint">Vel</label>
            <NumField value={selVel} min={1} max={127} width={44} onChange={setVelocity} title="Velocity of the selected notes (1–127); drag the bars below for single notes" />
          </>
        )}
        <button
          className="btn sm ghost icon"
          title="Duplicate selection (Ctrl+D)"
          disabled={!sel.size}
          onClick={() => onKey({ key: 'd', ctrlKey: true, preventDefault() {}, stopPropagation() {} } as unknown as React.KeyboardEvent)}
        >
          <Copy size={13} />
        </button>
        <button className="btn sm ghost icon" title="Delete selection (Del)" disabled={!sel.size} onClick={() => commit(events.filter((e) => !sel.has(sig(e))))}>
          <Trash2 size={13} />
        </button>
        <span className="spacer" />
        {chordsHint && <span className="small faint ellipsis" title={chordsHint}>{chordsHint}</span>}
        <span className="small faint">{sel.size ? `${sel.size} selected` : `${events.length} notes`}</span>
        <button className="btn sm ghost icon" onClick={() => setPpb((z) => Math.max(10, z / 1.4))} title="Zoom out">
          <ZoomOut size={13} />
        </button>
        <button className="btn sm ghost icon" onClick={() => setPpb((z) => Math.min(240, z * 1.4))} title="Zoom in">
          <ZoomIn size={13} />
        </button>
      </div>
      <div
        className="pr-scroll"
        ref={scroller}
        onPointerDown={() => {
          userScroll.current = performance.now();
        }}
        onScroll={(e) => {
          if (velScroller.current) velScroller.current.scrollLeft = (e.target as HTMLElement).scrollLeft;
        }}
      >
        <div className="pr-canvas" style={{ width: width + KEYS_W, height: height + 18 }}>
          <div className="pr-ruler" style={{ width: width + KEYS_W }}>
            <div className="pr-corner" />
            {Array.from({ length: bars }, (_, b) => (
              <span key={b} style={{ left: KEYS_W + b * barLen * ppb }}>
                {b + 1}
              </span>
            ))}
          </div>
          <div className="pr-keys" style={{ height }} ref={keysEl}>
            {Array.from({ length: 128 }, (_, i) => {
              const p = 127 - i;
              return (
                <div
                  key={p}
                  className={`pr-key${isBlackKey(p) ? ' black' : ''}${p % 12 === 0 ? ' c' : ''}`}
                  style={{ top: i * ROW, height: ROW }}
                  data-p={p}
                  onPointerDown={(ev) => keyPress(p, ev)}
                  onPointerUp={keyRelease}
                  onPointerCancel={keyRelease}
                >
                  {p % 12 === 0 ? midiName(p) : ''}
                </div>
              );
            })}
          </div>
          <div
            className="pr-grid"
            tabIndex={0}
            style={{
              left: KEYS_W,
              width,
              height,
              backgroundSize: `${barLen * ppb}px 100%, ${beatLen * ppb}px 100%, ${(snapV || beatLen) * ppb}px 100%`,
            }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={onKey}
          >
            <div className="pr-rows">
              {Array.from({ length: 128 }, (_, i) =>
                isBlackKey(127 - i) || (127 - i) % 12 === 0 ? <div key={i} className={isBlackKey(127 - i) ? 'b' : 'c'} style={{ top: i * ROW, height: ROW }} /> : null,
              )}
              {scaleRows &&
                Array.from({ length: 128 }, (_, i) => {
                  const pc = (127 - i) % 12;
                  return scaleRows.set.has(pc) ? <div key={`s${i}`} className={pc === scaleRows.root ? 'r' : 's'} style={{ top: i * ROW, height: ROW }} /> : null;
                })}
            </div>
            <div className="pr-end" style={{ left: length * ppb }} />
            {ghostShown.map((e, i) => (
              <div key={`g${i}`} className="pr-ghost" style={{ left: e.t * ppb, top: (127 - (e.p ?? 60)) * ROW, width: Math.max(2, e.l * ppb) }} />
            ))}
            {shown.map((e) => (
              <div
                key={`${sig(e)}|${e.l}`}
                className={`pr-note${sel.has(sig(e)) ? ' sel' : ''}`}
                style={{ left: e.t * ppb, top: (127 - (e.p ?? 60)) * ROW + 1, width: Math.max(3, e.l * ppb - 1), opacity: 0.45 + e.v * 0.55 }}
                title={`${midiName(e.p ?? 60)} · ${r6(e.l)} beats · vel ${Math.round(e.v * 127)}${e.c ? ` · [${e.c}]` : ''}`}
              >
                {e.l * ppb > 26 ? midiName(e.p ?? 60) : ''}
              </div>
            ))}
            {box && <div className="pr-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />}
          </div>
          <div className="pr-head" ref={head} style={{ height: height + 18 }} />
        </div>
      </div>
      <div className="pr-vel" ref={velScroller}>
        <div
          style={{ width: width + KEYS_W, height: VEL_H, position: 'relative' }}
          onPointerDown={(ev) => {
            capture(ev);
            drag.current = { mode: 'vel', orig: events };
            setPreview(velAt(ev, events));
          }}
          onPointerMove={(ev) => {
            if (drag.current?.mode !== 'vel') return;
            setPreview((p) => velAt(ev, p ?? events));
          }}
          onPointerUp={() => {
            const p = preview;
            drag.current = null;
            setPreview(null);
            if (p && p !== events) commit(p);
          }}
        >
          <div className="pr-vel-label">vel</div>
          {shown.map((e) => (
            <div
              key={`v${sig(e)}`}
              className={`pr-velbar${sel.has(sig(e)) ? ' sel' : ''}`}
              style={{ left: KEYS_W + e.t * ppb, height: Math.max(2, e.v * (VEL_H - 4)) }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
