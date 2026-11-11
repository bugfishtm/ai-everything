import { ArrowLeft, ArrowRight, Copy, MoreHorizontal, Plus, Repeat, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { NumField, TextField } from './controls';
import { qToSec, secToQ } from './timeline';
import type { DawPattern, PlayEntry, SongModel } from './types';

/** Pointer capture that tolerates pointers the browser does not track (pen/touch edge cases, synthetic events). */
function capture(e: React.PointerEvent): void {
  try {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  } catch {
    /* not capturable */
  }
}

const HEAD_W = 156;
const ROW_H = 30;

export const PATTERN_COLORS = ['#a78bfa', '#22d3ee', '#34d399', '#fbbf24', '#f472b6', '#60a5fa', '#fb923c', '#a3e635', '#e879f9', '#2dd4bf'];
export const colorOf = (names: string[], name: string) => PATTERN_COLORS[Math.max(0, names.indexOf(name)) % PATTERN_COLORS.length];

interface Props {
  model: SongModel;
  selPattern: string | null;
  selSection: number | null;
  loop: { a: number; b: number } | null;
  loopOn: boolean;
  position: () => number;
  onSelectPattern: (p: string) => void;
  onEditPattern: (p: string) => void;
  onSelectSection: (i: number | null) => void;
  onToggle: (i: number, pattern: string) => void;
  onClipMenu: (i: number, entry: PlayEntry, x: number, y: number) => void;
  onPatternMenu: (p: string, x: number, y: number) => void;
  onSeek: (sec: number) => void;
  onLoop: (a: number, b: number) => void;
  onSection: (i: number, field: 'section' | 'bars' | 'bpm' | 'transpose', value: unknown) => void;
  onSectionAction: (i: number, action: 'left' | 'right' | 'duplicate' | 'delete' | 'loop' | 'add') => void;
  onAddPattern: () => void;
  /** keep the playhead in view while the song plays */
  follow?: boolean;
  playing?: boolean;
  /** false: the transport is not on the song timeline (pattern mode) — no playhead here */
  showHead?: boolean;
}

export function Arrangement(props: Props) {
  const { model, selPattern, selSection, loop, loopOn, position, follow, playing, showHead = true } = props;
  const [ppb, setPpb] = useState(26); // px per bar
  const head = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const userScroll = useRef(0);
  const loopDrag = useRef<{ q0: number } | null>(null);
  const [loopPreview, setLoopPreview] = useState<{ a: number; b: number } | null>(null);
  const barLen = model.song.barLen;
  const names = Object.keys(model.patterns);
  const totalBars = model.sections.reduce((a, s) => a + s.bars, 0);
  const width = Math.max(1, Math.ceil(totalBars)) * ppb + 80;

  useEffect(() => {
    let raf = 0;
    const loopFn = () => {
      const x = (secToQ(model, position()) / barLen) * ppb;
      if (head.current) head.current.style.transform = `translateX(${x}px)`;
      // follow: turn the page when the playhead leaves the view (not while the user scrolls)
      const el = scroller.current;
      if (follow && playing && showHead && el && !loopDrag.current && performance.now() - userScroll.current > 2500) {
        const view = el.clientWidth - HEAD_W;
        if (view > 80 && (x < el.scrollLeft || x > el.scrollLeft + view - 24)) el.scrollLeft = Math.max(0, x - view * 0.1);
      }
      raf = requestAnimationFrame(loopFn);
    };
    raf = requestAnimationFrame(loopFn);
    return () => cancelAnimationFrame(raf);
  }, [model, position, ppb, barLen, follow, playing, showHead]);

  // Ctrl+wheel zooms (native, non-passive listener: the page must not zoom)
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const fn = (ev: WheelEvent) => {
      userScroll.current = performance.now();
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      setPpb((z) => Math.min(160, Math.max(8, z * (ev.deltaY < 0 ? 1.15 : 1 / 1.15))));
    };
    el.addEventListener('wheel', fn, { passive: false });
    return () => el.removeEventListener('wheel', fn);
  }, []);

  const xToQ = (e: React.PointerEvent | React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return Math.max(0, ((e.clientX - r.left) / ppb) * barLen);
  };
  const shownLoop = loopPreview ?? loop;
  const sec = selSection !== null ? model.sections[selSection] : null;

  return (
    <div className="arr">
      <div className="arr-bar">
        {sec && selSection !== null ? (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="small faint">Section</span>
            <TextField value={sec.name} width={110} onChange={(v) => v.trim() && props.onSection(selSection, 'section', v.trim())} />
            <span className="small faint">bars</span>
            <NumField value={sec.bars} min={0.25} max={512} width={52} onChange={(v) => v && props.onSection(selSection, 'bars', v)} />
            <span className="small faint">bpm</span>
            <NumField value={sec.bpm} min={20} max={400} width={56} onChange={(v) => props.onSection(selSection, 'bpm', v === model.song.bpm ? undefined : v)} title="empty = song tempo" />
            <span className="small faint">transpose</span>
            <NumField value={sec.transpose || 0} min={-48} max={48} width={46} onChange={(v) => props.onSection(selSection, 'transpose', v || undefined)} />
            <button className="btn sm ghost icon" title="Move left" disabled={selSection === 0} onClick={() => props.onSectionAction(selSection, 'left')}>
              <ArrowLeft size={13} />
            </button>
            <button className="btn sm ghost icon" title="Move right" disabled={selSection >= model.sections.length - 1} onClick={() => props.onSectionAction(selSection, 'right')}>
              <ArrowRight size={13} />
            </button>
            <button className="btn sm ghost icon" title="Duplicate section" onClick={() => props.onSectionAction(selSection, 'duplicate')}>
              <Copy size={13} />
            </button>
            <button className="btn sm ghost icon" title="Loop this section" onClick={() => props.onSectionAction(selSection, 'loop')}>
              <Repeat size={13} />
            </button>
            <button className="btn sm ghost icon" title="Delete section" disabled={model.sections.length <= 1} onClick={() => props.onSectionAction(selSection, 'delete')}>
              <Trash2 size={13} />
            </button>
          </div>
        ) : (
          <span className="small faint">
            Click a cell to play a pattern in a section · double-click a clip to edit it · drag on the ruler to set a loop
          </span>
        )}
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => props.onSectionAction(model.sections.length, 'add')} title="Add a section at the end">
          <Plus size={13} /> Section
        </button>
        <button className="btn sm ghost" onClick={props.onAddPattern} title="New pattern">
          <Plus size={13} /> Pattern
        </button>
        <button className="btn sm ghost icon" onClick={() => setPpb((z) => Math.max(8, z / 1.3))} title="Zoom out">
          <ZoomOut size={13} />
        </button>
        <button className="btn sm ghost icon" onClick={() => setPpb((z) => Math.min(160, z * 1.3))} title="Zoom in">
          <ZoomIn size={13} />
        </button>
      </div>
      <div
        className="arr-scroll"
        ref={scroller}
        onPointerDown={() => {
          userScroll.current = performance.now();
        }}
      >
        <div className="arr-inner" style={{ width: HEAD_W + width }}>
          {/* section headers */}
          <div className="arr-row arr-secs">
            <div className="arr-head arr-corner">
              {model.implicitArrangement && <span className="badge" title="No arrangement in the file yet: all patterns play together. Editing creates one.">auto</span>}
            </div>
            <div className="arr-lane">
              {model.sections.map((s, i) => (
                <div
                  key={i}
                  className={`arr-sec${selSection === i ? ' sel' : ''}`}
                  style={{ left: (s.startQ / barLen) * ppb, width: s.bars * ppb }}
                  onClick={() => props.onSelectSection(selSection === i ? null : i)}
                  onDoubleClick={() => props.onSeek(s.startSec)}
                  title={`${s.name} · ${s.bars} bars · ${s.bpm} bpm${s.transpose ? ` · transpose ${s.transpose}` : ''} — click: edit, double-click: play from here`}
                >
                  <span className="ellipsis">{s.name}</span>
                  {s.bpm !== model.song.bpm && <span className="arr-bpm">{s.bpm}</span>}
                </div>
              ))}
            </div>
          </div>
          {/* ruler */}
          <div className="arr-row arr-ruler-row">
            <div className="arr-head small faint">{model.song.bpm} bpm · {model.song.time}</div>
            <div
              className="arr-lane arr-ruler"
              onPointerDown={(e) => {
                capture(e);
                const q = xToQ(e);
                loopDrag.current = { q0: q };
              }}
              onPointerMove={(e) => {
                const d = loopDrag.current;
                if (!d) return;
                const q = xToQ(e);
                if (Math.abs(q - d.q0) < barLen / 4) return;
                const a = Math.floor(Math.min(q, d.q0) / barLen) * barLen;
                const b = Math.ceil(Math.max(q, d.q0) / barLen) * barLen;
                setLoopPreview({ a: qToSec(model, a), b: qToSec(model, b) });
              }}
              onPointerUp={(e) => {
                const d = loopDrag.current;
                loopDrag.current = null;
                if (loopPreview) {
                  props.onLoop(loopPreview.a, loopPreview.b);
                  setLoopPreview(null);
                } else if (d) props.onSeek(qToSec(model, Math.floor(xToQ(e) / barLen) * barLen));
              }}
            >
              {Array.from({ length: Math.ceil(totalBars) + 1 }, (_, b) =>
                ppb >= 16 || b % 4 === 0 ? (
                  <span key={b} className="arr-tick" style={{ left: b * ppb }}>
                    {b + 1}
                  </span>
                ) : null,
              )}
              {shownLoop && (
                <div
                  className={`arr-loop${loopOn ? ' on' : ''}`}
                  style={{ left: (secToQ(model, shownLoop.a) / barLen) * ppb, width: ((secToQ(model, shownLoop.b) - secToQ(model, shownLoop.a)) / barLen) * ppb }}
                />
              )}
            </div>
          </div>
          {/* pattern rows */}
          {names.map((p) => (
            <div key={p} className={`arr-row${selPattern === p ? ' sel' : ''}`} style={{ height: ROW_H }}>
              <div
                className="arr-head arr-pat"
                onClick={() => props.onSelectPattern(p)}
                onDoubleClick={() => props.onEditPattern(p)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  props.onPatternMenu(p, e.clientX, e.clientY);
                }}
                title={`${p}: ${Object.keys(model.patterns[p].tracks).join(', ')} · ${model.patterns[p].length / barLen} bar(s)`}
              >
                <span className="dot" style={{ background: colorOf(names, p) }} />
                <span className="ellipsis grow">{p}</span>
                <span className="faint small">{Math.round((model.patterns[p].length / barLen) * 100) / 100}</span>
                <button
                  className="icon-mini"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onPatternMenu(p, e.clientX, e.clientY);
                  }}
                >
                  <MoreHorizontal size={12} />
                </button>
              </div>
              <div className="arr-lane">
                {model.sections.map((s, i) => {
                  const entry = s.play.find((x) => x.pattern === p);
                  const left = (s.startQ / barLen) * ppb;
                  const w = s.bars * ppb;
                  return (
                    <div
                      key={i}
                      className={`arr-cell${entry ? ' on' : ''}${selSection === i ? ' selsec' : ''}`}
                      style={{ left, width: w }}
                      onClick={() => props.onToggle(i, p)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        props.onEditPattern(p);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (entry) props.onClipMenu(i, entry, e.clientX, e.clientY);
                      }}
                      title={entry ? `${p} in ${s.name}${Object.keys(entry.opts).length ? ` ${JSON.stringify(entry.opts)}` : ''} — click: remove, double-click: edit, right-click: options` : `click: play ${p} in ${s.name}`}
                    >
                      {entry && <Clip pattern={model.patterns[p]} entry={entry} bars={s.bars} barLen={barLen} ppb={ppb} color={colorOf(names, p)} />}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="arr-head-line" ref={head} style={{ left: HEAD_W, display: showHead ? undefined : 'none' }} />
        </div>
      </div>
    </div>
  );
}

/** Mini picture of a pattern looped over a section. */
const Clip = memo(function Clip({ pattern, entry, bars, barLen, ppb, color }: { pattern: DawPattern; entry: PlayEntry; bars: number; barLen: number; ppb: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const w = Math.max(2, Math.round(bars * ppb) - 2);
  const h = ROW_H - 6;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = h * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const secLen = bars * barLen;
    const plen = entry.opts.bars ? Number(entry.opts.bars) * barLen : pattern.length;
    const start = Number(entry.opts.offset ?? 0) * barLen;
    let lo = 127;
    let hi = 0;
    for (const t of Object.values(pattern.tracks)) for (const e of t.events) if (e.p !== undefined) ((lo = Math.min(lo, e.p)), (hi = Math.max(hi, e.p)));
    if (hi < lo) ((lo = 48), (hi = 72));
    const span = Math.max(12, hi - lo);
    g.fillStyle = color;
    const qx = (q: number) => (q / secLen) * w;
    for (let rep = 0; plen > 0 && start + rep < secLen - 1e-9; rep += plen) {
      for (const t of Object.values(pattern.tracks)) {
        for (const e of t.events) {
          if (e.t >= plen) continue;
          const q = start + rep + e.t;
          if (q >= secLen) continue;
          if (e.p !== undefined) {
            const y = 2 + (1 - (e.p - lo) / span) * (h - 5);
            g.globalAlpha = 0.9;
            g.fillRect(qx(q), y, Math.max(1, qx(Math.min(e.l, secLen - q))), 2);
          } else {
            g.globalAlpha = 0.35 + e.v * 0.4;
            g.fillRect(qx(q), h - 7, 1.5, 6);
          }
        }
      }
      if (rep > 0) {
        g.globalAlpha = 0.35;
        g.fillRect(qx(start + rep), 0, 1, h);
      }
    }
  }, [pattern, entry, bars, barLen, w, h, color]);
  const opts = entry.opts;
  const badge = [opts.transpose ? `${Number(opts.transpose) > 0 ? '+' : ''}${opts.transpose}` : '', opts.velocity !== undefined ? `v${opts.velocity}` : '', opts.only ? 'only' : ''].filter(Boolean).join(' ');
  return (
    <div className="arr-clip" style={{ borderColor: color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}>
      <canvas ref={ref} style={{ width: w, height: h }} />
      {badge && <span className="arr-clip-badge">{badge}</span>}
    </div>
  );
});
