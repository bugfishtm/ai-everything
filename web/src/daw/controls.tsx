// Small controls of the DAW: knobs, faders, number fields and a parameter widget that follows the
// UI hints of instruments/effects (also plugins Claude wrote: params={"cutoff": {"value": 800, "min": …}}).
import { RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ParamSpec } from './types';

/** Pointer capture that tolerates pointers the browser does not track (pen/touch edge cases, synthetic events). */
function capture(e: React.PointerEvent): void {
  try {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  } catch {
    /* not capturable */
  }
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function toNorm(v: number, s: Required<Pick<ParamSpec, 'min' | 'max'>> & ParamSpec): number {
  const { min, max } = s;
  if (max <= min) return 0;
  if (s.scale === 'log' && min > 0) return clamp(Math.log(v / min) / Math.log(max / min), 0, 1);
  const n = clamp((v - min) / (max - min), 0, 1);
  return s.scale === 'pow' ? Math.sqrt(n) : n;
}

function fromNorm(n: number, s: Required<Pick<ParamSpec, 'min' | 'max'>> & ParamSpec): number {
  const { min, max } = s;
  n = clamp(n, 0, 1);
  let v: number;
  if (s.scale === 'log' && min > 0) v = min * (max / min) ** n;
  else v = min + (max - min) * (s.scale === 'pow' ? n * n : n);
  const step = s.step ?? 0;
  if (step > 0) v = Math.round(v / step) * step;
  return Math.round(v * 1e6) / 1e6;
}

export function fmtNum(v: number, unit?: string): string {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  let s: string;
  if (unit === 'Hz' && a >= 1000) s = `${(v / 1000).toFixed(a >= 10000 ? 1 : 2)}k`;
  else if (a >= 100 || Number.isInteger(v)) s = String(Math.round(v * 10) / 10);
  else if (a >= 10) s = v.toFixed(1);
  else if (a >= 1) s = v.toFixed(2);
  else s = v.toFixed(3);
  return unit ? `${s}${unit === 'Hz' || unit === 'dB' ? ' ' : ''}${unit}` : s;
}

/** Rotary knob: drag up/down (shift = fine), wheel, double-click = default. */
export function Knob({
  value,
  spec,
  label,
  onChange,
  def,
  size = 34,
  title,
  bipolar,
}: {
  value: number;
  spec: ParamSpec;
  label?: ReactNode;
  onChange: (v: number, done: boolean) => void;
  def?: number;
  size?: number;
  title?: string;
  bipolar?: boolean;
}) {
  const s = { min: spec.min ?? 0, max: spec.max ?? 1, ...spec };
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? value;
  const n = toNorm(shown, s);
  const start = useRef<{ y: number; n: number } | null>(null);
  const a0 = -135;
  const ang = a0 + n * 270;
  const r = size / 2 - 3;
  const pt = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [size / 2 + r * Math.cos(rad), size / 2 + r * Math.sin(rad)];
  };
  const arc = (from: number, to: number) => {
    const [x1, y1] = pt(from);
    const [x2, y2] = pt(to);
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} ${to > from ? 1 : 0} ${x2} ${y2}`;
  };
  const zero = bipolar ? a0 + toNorm(0, s) * 270 : a0;
  // native, non-passive wheel listener: turning a knob must not scroll the page
  const svgRef = useRef<SVGSVGElement>(null);
  const wheel = useRef<(e: WheelEvent) => void>(() => {});
  wheel.current = (e: WheelEvent) => {
    e.preventDefault();
    onChange(fromNorm(n + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.005 : 0.02), s), true);
  };
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const fn = (e: WheelEvent) => wheel.current(e);
    el.addEventListener('wheel', fn, { passive: false });
    return () => el.removeEventListener('wheel', fn);
  }, []);
  return (
    <div className="knob" title={title ?? `${fmtNum(shown, s.unit)} — drag, wheel, double-click resets`}>
      <svg
        ref={svgRef}
        width={size}
        height={size}
        onPointerDown={(e) => {
          capture(e);
          start.current = { y: e.clientY, n };
          setDrag(shown);
        }}
        onPointerMove={(e) => {
          if (!start.current) return;
          const dn = ((start.current.y - e.clientY) / (e.shiftKey ? 600 : 150)) * 1;
          const v = fromNorm(start.current.n + dn, s);
          setDrag(v);
          onChange(v, false);
        }}
        onPointerUp={() => {
          if (start.current && drag !== null) onChange(drag, true);
          start.current = null;
          setDrag(null);
        }}
        onDoubleClick={() => def !== undefined && onChange(def, true)}
      >
        <path d={arc(a0, a0 + 270)} className="knob-track" />
        {Math.abs(ang - zero) > 0.5 && <path d={ang > zero ? arc(zero, ang) : arc(ang, zero)} className="knob-val" />}
        <line x1={size / 2} y1={size / 2} x2={pt(ang)[0]} y2={pt(ang)[1]} className="knob-hand" />
      </svg>
      {label !== undefined && <span className="knob-label">{label}</span>}
      <span className="knob-value">{fmtNum(shown, s.unit)}</span>
    </div>
  );
}

/** Vertical fader in dB. */
export function Fader({ db, onChange, min = -48, max = 12, height = 110 }: { db: number; onChange: (v: number, done: boolean) => void; min?: number; max?: number; height?: number }) {
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? db;
  const norm = (v: number) => clamp((v - min) / (max - min), 0, 1);
  const ref = useRef<HTMLDivElement>(null);
  const at = (clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    const n = clamp(1 - (clientY - r.top) / r.height, 0, 1);
    return Math.round((min + n * (max - min)) * 2) / 2;
  };
  return (
    <div className="fader" style={{ height }} title={`${fmtNum(shown, 'dB')} — double-click: 0 dB`}>
      <div
        className="fader-track"
        ref={ref}
        onPointerDown={(e) => {
          capture(e);
          const v = at(e.clientY);
          setDrag(v);
          onChange(v, false);
        }}
        onPointerMove={(e) => {
          if (drag === null) return;
          const v = at(e.clientY);
          setDrag(v);
          onChange(v, false);
        }}
        onPointerUp={() => {
          if (drag !== null) onChange(drag, true);
          setDrag(null);
        }}
        onDoubleClick={() => onChange(0, true)}
      >
        <div className="fader-zero" style={{ bottom: `${norm(0) * 100}%` }} />
        <div className="fader-cap" style={{ bottom: `calc(${norm(shown) * 100}% - 6px)` }} />
      </div>
    </div>
  );
}

/** Number input that commits on Enter/blur. */
export function NumField({
  value,
  onChange,
  min,
  max,
  step,
  width = 64,
  placeholder,
  title,
}: {
  value: number | undefined | null;
  onChange: (v: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  width?: number;
  placeholder?: string;
  title?: string;
}) {
  const [s, setS] = useState(value === undefined || value === null ? '' : String(value));
  useEffect(() => setS(value === undefined || value === null ? '' : String(value)), [value]);
  const commit = () => {
    if (s.trim() === '') {
      if (value !== undefined && value !== null) onChange(undefined);
      return;
    }
    let v = Number(s);
    if (!Number.isFinite(v)) {
      setS(value === undefined || value === null ? '' : String(value));
      return;
    }
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    if (v !== value) onChange(v);
    else setS(String(v));
  };
  return (
    <input
      className="daw-input"
      style={{ width }}
      value={s}
      placeholder={placeholder}
      title={title}
      inputMode="decimal"
      step={step}
      onChange={(e) => setS(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setS(value === undefined || value === null ? '' : String(value));
          (e.target as HTMLInputElement).blur();
        }
        e.stopPropagation();
      }}
    />
  );
}

export function TextField({
  value,
  onChange,
  width,
  placeholder,
  mono,
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  width?: number | string;
  placeholder?: string;
  mono?: boolean;
  title?: string;
}) {
  const [s, setS] = useState(value);
  useEffect(() => setS(value), [value]);
  return (
    <input
      className={`daw-input${mono ? ' mono' : ''}`}
      style={{ width }}
      value={s}
      placeholder={placeholder}
      title={title}
      onChange={(e) => setS(e.target.value)}
      onBlur={() => s !== value && onChange(s)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setS(value);
          (e.target as HTMLInputElement).blur();
        }
        e.stopPropagation();
      }}
    />
  );
}

/** One parameter of an instrument or effect, rendered from its UI hints. */
export function ParamControl({
  name,
  value,
  spec,
  def,
  overridden,
  onChange,
  onReset,
}: {
  name: string;
  value: unknown;
  spec: ParamSpec;
  def?: unknown;
  overridden?: boolean;
  onChange: (v: unknown, done: boolean) => void;
  onReset?: () => void;
}) {
  const label = (
    <span className={overridden ? 'param-set' : ''} title={spec.doc ?? (overridden ? 'set in the song' : 'default')}>
      {spec.label ?? name}
    </span>
  );
  const reset = overridden && onReset && (
    <button className="icon-mini" title={`reset to default (${JSON.stringify(def)})`} onClick={onReset}>
      <RotateCcw size={10} />
    </button>
  );
  const type = spec.type ?? (typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'bool' : typeof value === 'string' ? 'text' : Array.isArray(value) ? 'list' : 'json');
  if (type === 'number' && typeof value === 'number') {
    return (
      <div className="param">
        <Knob value={value} spec={spec} label={label} def={typeof def === 'number' ? def : undefined} onChange={(v, done) => onChange(v, done)} bipolar={(spec.min ?? 0) < 0} />
        {reset}
      </div>
    );
  }
  if (type === 'bool') {
    return (
      <div className="param param-wide">
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked, true)} /> {label}
        </label>
        {reset}
      </div>
    );
  }
  if (type === 'select' && spec.options) {
    return (
      <div className="param param-wide">
        <span className="small">{label}</span>
        <select className="daw-input" value={String(value)} onChange={(e) => onChange(e.target.value, true)}>
          {[...new Set([String(value), ...spec.options])].map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        {reset}
      </div>
    );
  }
  if (type === 'list' && Array.isArray(value) && value.every((x) => typeof x === 'number')) {
    return (
      <div className="param param-wide">
        <span className="small">{label}</span>
        <TextField
          mono
          width={150}
          value={(value as number[]).join(', ')}
          onChange={(s) => {
            const arr = s.split(/[,\s]+/).filter(Boolean).map(Number);
            if (arr.every((x) => Number.isFinite(x))) onChange(arr, true);
          }}
        />
        {reset}
      </div>
    );
  }
  return (
    <div className="param param-wide">
      <span className="small">{label}</span>
      <TextField
        mono
        width={140}
        value={typeof value === 'string' ? value : JSON.stringify(value)}
        onChange={(s) => {
          if (typeof value === 'string') onChange(s, true);
          else {
            try {
              onChange(JSON.parse(s), true);
            } catch {
              onChange(s, true);
            }
          }
        }}
      />
      {reset}
    </div>
  );
}

const DB_FLOOR = -54;
const dbOf = (amp: number) => 20 * Math.log10(Math.max(amp, 1e-5));
const meterNorm = (db: number) => clamp((db - DB_FLOOR) / -DB_FLOOR, 0, 1);

/** Level meter fed by a callback (polled with requestAnimationFrame), with a peak-hold line. */
export function Meter({ read, vertical = true, hold = true }: { read: () => number; vertical?: boolean; hold?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const peakRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let shown = 0;
    let peak = 0;
    let peakAt = 0;
    let lastN = -1;
    let lastP = -1;
    const loop = (now: number) => {
      const v = read();
      shown = Math.max(v, shown * 0.9);
      const db = dbOf(shown);
      const n = Math.round(meterNorm(db) * 1000) / 10;
      if (ref.current && n !== lastN) {
        lastN = n;
        ref.current.style[vertical ? 'height' : 'width'] = `${n}%`;
        ref.current.style.background = db > -1 ? 'var(--danger)' : db > -9 ? 'var(--warn)' : 'var(--ok)';
      }
      if (hold && peakRef.current) {
        // the highest level stays for a moment, then falls
        if (v >= peak) {
          peak = v;
          peakAt = now;
        } else if (now - peakAt > 1400) peak = Math.max(v, peak * 0.94);
        const pdb = dbOf(peak);
        const pn = peak > 2e-3 ? Math.round(meterNorm(pdb) * 1000) / 10 : 0;
        if (pn !== lastP) {
          lastP = pn;
          peakRef.current.style[vertical ? 'bottom' : 'left'] = `${pn}%`;
          peakRef.current.style.opacity = pn > 0 ? '1' : '0';
          peakRef.current.style.background = pdb > -1 ? 'var(--danger)' : 'var(--text)';
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [read, vertical, hold]);
  return (
    <div className={`meter-bar${vertical ? '' : ' h'}`}>
      <div ref={ref} className="meter-fill" />
      {hold && <div ref={peakRef} className="meter-peak" />}
    </div>
  );
}

/** The highest level since the last click, in dBFS (red when it reached full scale). */
export function PeakReadout({ read, title }: { read: () => number; title?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const max = useRef(0);
  useEffect(() => {
    let raf = 0;
    let last = '';
    const loop = () => {
      const v = read();
      if (v > max.current) max.current = v;
      const db = dbOf(max.current);
      const text = max.current < 1e-4 ? '-∞' : db.toFixed(1);
      if (ref.current && text !== last) {
        last = text;
        ref.current.textContent = text;
        ref.current.classList.toggle('clip', db >= -0.1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [read]);
  return (
    <button
      ref={ref}
      className="peak-read"
      title={title ?? 'Peak level (dBFS) since the last reset — click to reset'}
      onClick={() => {
        max.current = 0;
      }}
    >
      -∞
    </button>
  );
}
