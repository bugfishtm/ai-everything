import { Plus, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DawEvent } from './types';

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const STEPS: { label: string; tok: string; v: number }[] = [
  { label: '1/4', tok: 'q', v: 1 },
  { label: '1/8', tok: 'e', v: 0.5 },
  { label: '1/16', tok: 's', v: 0.25 },
  { label: '1/32', tok: 't', v: 0.125 },
  { label: '1/8 T', tok: 'e3', v: 1 / 3 },
  { label: '1/16 T', tok: 's3', v: 1 / 6 },
];

interface Props {
  events: DawEvent[];
  rows: string[];
  sounds: string[];
  length: number;
  barLen: number;
  beatLen: number;
  step: number;
  gate: number;
  onChange: (events: DawEvent[], rows: string[]) => void;
  onStep: (tok: string) => void;
  onAudition: (k: string, v: number) => void;
  playhead?: () => number | null;
  /** keep the playhead in view while playing */
  follow?: boolean;
}

export function StepGrid({ events, rows: rowsIn, sounds, length, barLen, beatLen, step, gate, onChange, onStep, onAudition, playhead, follow }: Props) {
  const [cw, setCw] = useState(22);
  const [extraRows, setExtraRows] = useState<string[]>([]);
  const paint = useRef<{ add: boolean; vel: number; done: Set<string>; next: DawEvent[] } | null>(null);
  const [preview, setPreview] = useState<DawEvent[] | null>(null);
  const head = useRef<HTMLDivElement>(null);
  const userScroll = useRef(0);

  const shown = preview ?? events;
  // a finer step if hits do not fit the written one (e.g. a 1/32 roll in a 1/16 grid)
  const eff = useMemo(() => {
    for (const div of [1, 2, 3, 4, 6, 8]) {
      const s = step / div;
      if (events.every((e) => Math.abs(e.t / s - Math.round(e.t / s)) < 1e-4)) return s;
    }
    return step;
  }, [events, step]);
  const rows = useMemo(() => {
    const r = [...rowsIn];
    for (const e of shown) if (e.k && !r.includes(e.k)) r.push(e.k);
    for (const x of extraRows) if (!r.includes(x)) r.push(x);
    return r.length ? r : [sounds[0] ?? 'kick'];
  }, [rowsIn, shown, extraRows, sounds]);
  const steps = Math.max(1, Math.round(Math.max(length, barLen) / eff));
  const perBar = barLen / eff;
  const perBeat = beatLen / eff;
  const hits = useMemo(() => {
    const m = new Map<string, DawEvent>();
    for (const e of shown) m.set(`${e.k}|${Math.round(e.t / eff)}`, e);
    return m;
  }, [shown, eff]);

  useEffect(() => {
    if (!playhead) return;
    let raf = 0;
    const loop = () => {
      const q = playhead();
      if (head.current) {
        head.current.style.display = q === null ? 'none' : 'block';
        if (q !== null) head.current.style.transform = `translateX(${(q / eff) * cw}px)`;
      }
      // follow: turn the page when the playhead leaves the view (not while the user scrolls or paints)
      const el = scrollRef.current;
      if (follow && q !== null && el && !paint.current && performance.now() - userScroll.current > 2500) {
        const x = (q / eff) * cw;
        const view = el.clientWidth - 120;
        if (view > 80 && (x < el.scrollLeft || x > el.scrollLeft + view - 24)) el.scrollLeft = Math.max(0, x - view * 0.1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playhead, eff, cw, follow]);

  const apply = (base: DawEvent[], row: string, i: number, add: boolean, vel: number): DawEvent[] => {
    const t = r6(i * eff);
    const without = base.filter((e) => !(e.k === row && Math.abs(e.t - t) < 1e-6));
    return add ? [...without, { t, l: eff, d: eff * gate, k: row, v: vel }] : without;
  };

  const down = (ev: React.PointerEvent, row: string, i: number) => {
    ev.preventDefault();
    (ev.currentTarget as HTMLElement).releasePointerCapture?.(ev.pointerId);
    const existing = hits.get(`${row}|${i}`);
    const add = ev.button !== 2 && !existing;
    const vel = ev.shiftKey ? 1 : ev.altKey ? 0.45 : 0.8;
    const next = apply(events, row, i, add, vel);
    paint.current = { add, vel, done: new Set([`${row}|${i}`]), next };
    setPreview(next);
    if (add) onAudition(row, vel);
    const up = () => {
      window.removeEventListener('pointerup', up);
      const p = paint.current;
      paint.current = null;
      setPreview(null);
      if (p) onChange(p.next, rows);
    };
    window.addEventListener('pointerup', up);
  };
  const enter = (row: string, i: number) => {
    const p = paint.current;
    if (!p || p.done.has(`${row}|${i}`)) return;
    p.done.add(`${row}|${i}`);
    p.next = apply(p.next, row, i, p.add, p.vel);
    setPreview(p.next);
  };
  // mouse wheel over a hit changes its velocity (native, non-passive listener: no page scrolling then)
  const scrollRef = useRef<HTMLDivElement>(null);
  const wheel = useRef<(ev: WheelEvent) => void>(() => {});
  wheel.current = (ev: WheelEvent) => {
    userScroll.current = performance.now();
    if (ev.ctrlKey || ev.metaKey) {
      // Ctrl+wheel zooms
      ev.preventDefault();
      setCw((z) => Math.min(60, Math.max(10, z * (ev.deltaY < 0 ? 1.15 : 1 / 1.15))));
      return;
    }
    const cell = (ev.target as HTMLElement).closest<HTMLElement>('.sg-cell');
    if (!cell?.dataset.row) return;
    const e = hits.get(`${cell.dataset.row}|${cell.dataset.i}`);
    if (!e) return;
    ev.preventDefault();
    const v = Math.min(1, Math.max(0.05, Math.round((e.v + (ev.deltaY < 0 ? 0.1 : -0.1)) * 20) / 20));
    onChange(events.map((x) => (x === e ? { ...x, v } : x)), rows);
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const fn = (ev: WheelEvent) => wheel.current(ev);
    el.addEventListener('wheel', fn, { passive: false });
    return () => el.removeEventListener('wheel', fn);
  }, []);

  const addRow = (name: string) => {
    const n = name.trim();
    if (!n || rows.includes(n)) return;
    setExtraRows((x) => [...x, n]);
    onChange(events, [...rows, n]);
  };
  const removeRow = (row: string) => {
    setExtraRows((x) => x.filter((r) => r !== row));
    onChange(
      events.filter((e) => e.k !== row),
      rows.filter((r) => r !== row),
    );
  };
  const free = sounds.filter((s) => !rows.includes(s));
  const stepTok = STEPS.find((s) => Math.abs(s.v - step) < 1e-6)?.tok ?? '';

  return (
    <div className="sg">
      <div className="pr-tools">
        <label className="small faint">Step</label>
        <select className="daw-input" value={stepTok} onChange={(e) => onStep(e.target.value)} title="Grid resolution (step: in the song)">
          {!stepTok && <option value="">{r6(step)} beats</option>}
          {STEPS.map((s) => (
            <option key={s.tok} value={s.tok}>
              {s.label}
            </option>
          ))}
        </select>
        {eff !== step && <span className="badge warn" title="Some hits sit between the steps; shown in a finer grid">finer: {r6(eff)}</span>}
        <span className="small faint">click = hit · Shift = accent · Alt = ghost · drag paints · wheel = velocity · right-click clears</span>
        <span className="spacer" />
        <select
          className="daw-input"
          value=""
          onChange={(e) => {
            if (e.target.value === '__custom') {
              const n = window.prompt('Row name (a sound of this instrument, e.g. kick, snare, hat, or a MIDI note number)');
              if (n) addRow(n);
            } else addRow(e.target.value);
          }}
          title="Add a sound row"
        >
          <option value="">+ row…</option>
          {free.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
          <option value="__custom">other…</option>
        </select>
        <button className="btn sm ghost icon" onClick={() => setCw((z) => Math.max(10, z / 1.25))} title="Zoom out">
          <ZoomOut size={13} />
        </button>
        <button className="btn sm ghost icon" onClick={() => setCw((z) => Math.min(60, z * 1.25))} title="Zoom in">
          <ZoomIn size={13} />
        </button>
      </div>
      <div
        className="sg-scroll"
        ref={scrollRef}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={() => {
          userScroll.current = performance.now();
        }}
      >
        <div className="sg-table" style={{ width: 120 + steps * cw }}>
          {rows.map((row) => (
            <div key={row} className="sg-row">
              <div className="sg-name">
                <button className="sg-play" title={`play ${row}`} onPointerDown={() => onAudition(row, 0.8)}>
                  {row}
                </button>
                <button className="icon-mini" title={`remove row ${row}`} onClick={() => removeRow(row)}>
                  <X size={11} />
                </button>
              </div>
              <div className="sg-cells">
                {Array.from({ length: steps }, (_, i) => {
                  const e = hits.get(`${row}|${i}`);
                  const cls = ['sg-cell'];
                  if (i % perBar === 0) cls.push('bar');
                  else if (Number.isInteger(perBeat) && i % perBeat === 0) cls.push('beat');
                  if (Math.floor(i / perBeat) % 2 === 1) cls.push('alt');
                  return (
                    <div
                      key={i}
                      className={cls.join(' ')}
                      style={{ width: cw }}
                      onPointerDown={(ev) => down(ev, row, i)}
                      onPointerEnter={() => enter(row, i)}
                      data-row={row}
                      data-i={i}
                      title={e ? `${row} · step ${i + 1} · vel ${Math.round(e.v * 127)}` : `${row} · step ${i + 1}`}
                    >
                      {e && <span className={`sg-hit${e.v >= 0.95 ? ' acc' : e.v < 0.5 ? ' ghost' : ''}`} style={{ opacity: 0.35 + e.v * 0.65 }} />}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="sg-head" ref={head} style={{ left: 120, height: rows.length * 26 }} />
        </div>
        {free.length > 0 && rows.length < 3 && (
          <div className="small faint" style={{ padding: '8px 12px' }}>
            <Plus size={11} /> More sounds of this instrument: {free.slice(0, 12).join(', ')}
          </div>
        )}
      </div>
    </div>
  );
}
