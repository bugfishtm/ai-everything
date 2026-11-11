// Small form controls of the 3D editor: numbers you can drag, vectors, colors, sliders, data fields.
import { ChevronDown, ChevronRight, Plus, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { parse as parseYaml } from 'yaml';
import { formatInline } from '../daw/yamlEdit';
import { round } from './sceneDoc';

const clamp = (v: number, min?: number, max?: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

/** Small sums typed into a number field: 1.5+0.25, 3*2, (10-4)/2. NaN when it is not arithmetic. */
export function calc(src: string): number {
  const s = src.replace(/\s+/g, '').replace(/,/g, '.');
  let i = 0;
  const number = (): number => {
    const m = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(s.slice(i));
    if (!m) return NaN;
    i += m[0].length;
    return Number(m[0]);
  };
  const factor = (): number => {
    if (s[i] === '-') return i++, -factor();
    if (s[i] === '+') return i++, factor();
    if (s[i] === '(') {
      i++;
      const v = sum();
      if (s[i] !== ')') return NaN;
      i++;
      return v;
    }
    return number();
  };
  const product = (): number => {
    let v = factor();
    while (s[i] === '*' || s[i] === '/') {
      const op = s[i++];
      const r = factor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  function sum(): number {
    let v = product();
    while (s[i] === '+' || s[i] === '-') {
      const op = s[i++];
      const r = product();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  if (!s) return NaN;
  const v = sum();
  return i === s.length ? v : NaN;
}
const show = (v: number | undefined | null) => (v === undefined || v === null || !Number.isFinite(v) ? '' : String(round(v, 4)));

/**
 * A number: type it, use the arrow keys, or drag its label left/right.
 * onChange(value, done) — done is false while dragging (the editor then keeps it one undo step).
 */
export function Num({
  value,
  onChange,
  label,
  min,
  max,
  step = 0.1,
  int,
  placeholder,
  title,
  tone,
  disabled,
}: {
  value: number | undefined | null;
  onChange: (v: number | undefined, done: boolean) => void;
  label?: ReactNode;
  min?: number;
  max?: number;
  step?: number;
  int?: boolean;
  placeholder?: string;
  title?: string;
  tone?: 'x' | 'y' | 'z';
  disabled?: boolean;
}) {
  const [s, setS] = useState(show(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setS(show(value));
  }, [value]);
  const fix = (v: number) => {
    const c = clamp(int ? Math.round(v) : v, min, max);
    return round(c, 4);
  };
  const commit = () => {
    if (s.trim() === '') {
      if (value !== undefined && value !== null && placeholder !== undefined) onChange(undefined, true);
      else setS(show(value));
      return;
    }
    let v = calc(s); // small sums are welcome: 1.5+0.25, 3*2, 10/4
    if (!Number.isFinite(v)) return setS(show(value));
    v = fix(v);
    setS(show(v));
    if (v !== value) onChange(v, true);
  };
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  return (
    <span className={`s3-num${tone ? ` ${tone}` : ''}${disabled ? ' off' : ''}`} title={title}>
      {label !== undefined && (
        <span
          className="s3-num-label"
          onPointerDown={(e) => {
            if (disabled) return;
            drag.current = { x: e.clientX, v: value ?? 0, moved: false };
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              /* not capturable */
            }
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dx = e.clientX - d.x;
            if (!d.moved && Math.abs(dx) < 3) return;
            d.moved = true;
            const k = e.shiftKey ? 0.1 : e.ctrlKey ? 10 : 1;
            const v = fix(d.v + (int ? Math.round((dx / 6) * k) * Math.max(1, Math.round(step)) : Math.round(dx / 2) * step * k));
            setS(show(v));
            onChange(v, false);
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            drag.current = null;
            if (!d?.moved) return;
            const dx = e.clientX - d.x;
            const k = e.shiftKey ? 0.1 : e.ctrlKey ? 10 : 1;
            onChange(fix(d.v + (int ? Math.round((dx / 6) * k) * Math.max(1, Math.round(step)) : Math.round(dx / 2) * step * k)), true);
          }}
        >
          {label}
        </span>
      )}
      <input
        value={s}
        disabled={disabled}
        placeholder={placeholder}
        inputMode="decimal"
        spellCheck={false}
        onFocus={(e) => {
          focused.current = true;
          e.target.select();
        }}
        onChange={(e) => setS(e.target.value)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'Escape') {
            setS(show(value));
            focused.current = false;
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const k = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
            const base = Number.isFinite(Number(s)) && s.trim() !== '' ? Number(s) : (value ?? 0);
            const v = fix(base + (e.key === 'ArrowUp' ? 1 : -1) * (int ? Math.max(1, Math.round(step)) : step) * k);
            setS(show(v));
            onChange(v, true);
          }
        }}
      />
    </span>
  );
}

const AXES = ['x', 'y', 'z'] as const;

/** A row of numbers (position, size …). `labels` default to X Y Z. */
export function Vec({
  value,
  onChange,
  labels,
  step,
  min,
  max,
  int,
  disabled,
}: {
  value: number[];
  onChange: (v: number[], done: boolean) => void;
  labels?: string[];
  step?: number;
  min?: number;
  max?: number;
  int?: boolean;
  disabled?: boolean;
}) {
  return (
    <span className="s3-vec">
      {value.map((x, i) => (
        <Num
          key={i}
          value={x}
          label={labels ? labels[i] : value.length <= 3 ? AXES[i].toUpperCase() : String(i + 1)}
          tone={!labels && value.length === 3 ? AXES[i] : undefined}
          step={step}
          min={min}
          max={max}
          int={int}
          disabled={disabled}
          onChange={(v, done) => {
            const next = [...value];
            next[i] = v ?? 0;
            onChange(next, done);
          }}
        />
      ))}
    </span>
  );
}

export function Row({ label, children, title, set, onReset }: { label: ReactNode; children: ReactNode; title?: string; set?: boolean; onReset?: () => void }) {
  return (
    <div className="s3-row" title={title}>
      <span className={`s3-label${set ? ' set' : ''}`}>{label}</span>
      <span className="s3-value">{children}</span>
      {set && onReset ? (
        <button className="icon-mini" title="Remove from the file (back to the default)" onClick={onReset}>
          <RotateCcw size={11} />
        </button>
      ) : (
        <span className="s3-reset-gap" />
      )}
    </div>
  );
}

export function Section({ title, children, actions, open: initial = true, badge }: { title: ReactNode; children: ReactNode; actions?: ReactNode; open?: boolean; badge?: ReactNode }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="s3-section">
      <div className="s3-section-head">
        <button className="s3-section-title" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {title}
          {badge}
        </button>
        {actions}
      </div>
      {open && <div className="s3-section-body">{children}</div>}
    </div>
  );
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** A color: the swatch opens the system picker (live while you move in it), the text takes any "#rrggbb". */
export function Color({ value, onChange, allowNone, placeholder }: { value: string | undefined; onChange: (v: string | undefined, done: boolean) => void; allowNone?: boolean; placeholder?: string }) {
  const [s, setS] = useState(value ?? '');
  useEffect(() => setS(value ?? ''), [value]);
  const hex = HEX6.test(s) ? s : HEX6.test(value ?? '') ? (value as string) : (placeholder ?? '#cfd3da');
  return (
    <span className="s3-color">
      <input
        type="color"
        value={hex.slice(0, 7)}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          setS(v);
          onChange(v, false);
        }}
        onChange={(e) => onChange(e.target.value, true)}
      />
      <input
        className="daw-input mono"
        value={s}
        placeholder={placeholder ?? '#rrggbb'}
        spellCheck={false}
        onChange={(e) => setS(e.target.value)}
        onBlur={() => {
          const v = s.trim();
          if (!v) {
            if (allowNone && value !== undefined) onChange(undefined, true);
            else setS(value ?? '');
            return;
          }
          const full = /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v) ? `#${v}` : v;
          if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) {
            if (full !== value) onChange(full, true);
            setS(full);
          } else setS(value ?? '');
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {allowNone && value !== undefined && (
        <button className="icon-mini" title="Remove" onClick={() => onChange(undefined, true)}>
          <X size={11} />
        </button>
      )}
    </span>
  );
}

export function Slider({ value, onChange, min = 0, max = 1, step = 0.01 }: { value: number; onChange: (v: number, done: boolean) => void; min?: number; max?: number; step?: number }) {
  return (
    <span className="s3-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={clamp(value, min, max)}
        onInput={(e) => onChange(Number((e.target as HTMLInputElement).value), false)}
        onChange={(e) => onChange(Number(e.target.value), true)}
        onPointerUp={(e) => onChange(Number((e.target as HTMLInputElement).value), true)}
      />
      <Num value={value} min={min} max={max} step={step} onChange={(v, done) => onChange(v ?? min, done)} />
    </span>
  );
}

export function Select({ value, options, onChange, placeholder, title }: { value: string; options: (string | { value: string; label: string })[]; onChange: (v: string) => void; placeholder?: string; title?: string }) {
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const known = opts.some((o) => o.value === value);
  return (
    <select className="daw-input s3-select" value={value} title={title} onChange={(e) => onChange(e.target.value)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {!known && value !== '' && <option value={value}>{value}</option>}
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Text({ value, onChange, placeholder, mono }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  const [s, setS] = useState(value);
  useEffect(() => setS(value), [value]);
  return (
    <input
      className={`daw-input s3-text${mono ? ' mono' : ''}`}
      value={s}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setS(e.target.value)}
      onBlur={() => s !== value && onChange(s)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setS(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** Any value as YAML text (lists of parts, nested data) — checked when you leave the field. */
export function DataField({ value, onChange, rows }: { value: unknown; onChange: (v: unknown) => void; rows?: number }) {
  const text = (v: unknown) => {
    if (v === undefined || v === null) return '';
    if (Array.isArray(v) && v.length > 1 && v.some((x) => x && typeof x === 'object')) return v.map((x) => `- ${formatInline(x)}`).join('\n');
    return formatInline(v);
  };
  const [s, setS] = useState(text(value));
  const [err, setErr] = useState('');
  useEffect(() => {
    setS(text(value));
    setErr('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);
  const lines = Math.min(12, Math.max(rows ?? 2, s.split('\n').length));
  return (
    <span className="s3-data">
      <textarea
        className="daw-input mono"
        rows={lines}
        value={s}
        spellCheck={false}
        onChange={(e) => setS(e.target.value)}
        onBlur={() => {
          if (s === text(value)) return;
          if (!s.trim()) return onChange(undefined);
          try {
            onChange(parseYaml(s));
            setErr('');
          } catch (e) {
            setErr((e as Error).message.split('\n')[0]);
          }
        }}
        onKeyDown={(e) => e.stopPropagation()}
      />
      {err && <span className="s3-err">{err}</span>}
    </span>
  );
}

/** A list of points / rows of numbers ([[x, z], …], [[radius, y], …], [[x, y, z], …]). */
export function Points({ value, onChange, labels }: { value: number[][]; onChange: (v: number[][], done: boolean) => void; labels?: string[] }) {
  const cols = Math.max(1, ...value.map((r) => r.length));
  return (
    <span className="s3-points">
      {value.map((row, i) => (
        <span key={i} className="s3-point">
          <span className="faint s3-point-n">{i + 1}</span>
          <Vec
            value={row}
            labels={labels ?? (cols <= 3 ? undefined : row.map((_, k) => String(k + 1)))}
            step={0.05}
            onChange={(v, done) => {
              const next = value.map((r) => [...r]);
              next[i] = v;
              onChange(next, done);
            }}
          />
          <button
            className="icon-mini"
            title="Add a point after this one"
            onClick={() => {
              const next = value.map((r) => [...r]);
              const b = value[i + 1];
              next.splice(i + 1, 0, b ? row.map((x, k) => round((x + (b[k] ?? x)) / 2, 4)) : [...row]);
              onChange(next, true);
            }}
          >
            <Plus size={11} />
          </button>
          <button className="icon-mini" title="Remove this point" disabled={value.length <= 2} onClick={() => onChange(value.filter((_, k) => k !== i), true)}>
            <X size={11} />
          </button>
        </span>
      ))}
    </span>
  );
}

export const isNumberRows = (v: unknown): v is number[][] =>
  Array.isArray(v) && v.length > 0 && v.every((r) => Array.isArray(r) && r.length > 0 && r.length <= 5 && r.every((x) => typeof x === 'number'));
export const isNumberList = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.length <= 4 && v.every((x) => typeof x === 'number');
