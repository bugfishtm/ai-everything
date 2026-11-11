// The on-screen keyboard: piano keys for pitched instruments, pads for drum kits. It plays the live
// instrument through the LivePlayer (so it is heard, recorded and sent to the MIDI output like a
// MIDI keyboard) and shows which computer keys play which note.
import { ChevronLeft, ChevronRight, Keyboard as KeyboardIcon, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TYPING_KEYS, type LivePlayer, type LiveTarget } from './live';
import { isBlackKey, midiName } from './notation';

const WHITE_W = 26;
const BLACK_W = 16;

interface Props {
  live: LivePlayer;
  target: LiveTarget | null;
  /** octave of the computer keyboard's first key (A = C of this octave) */
  octave: number;
  onOctave: (o: number) => void;
  velocity: number;
  onVelocity: (v: number) => void;
  typing: boolean;
  onTyping: (on: boolean) => void;
  /** what is printed on the typing keys of this computer */
  labels: Record<string, string>;
  recording: boolean;
  onClose: () => void;
}

const CODE_OF = Object.entries(TYPING_KEYS).reduce<Record<number, string>>((m, [code, semi]) => {
  m[semi] = code;
  return m;
}, {});

export function KeyboardPanel({ live, target, octave, onOctave, velocity, onVelocity, typing, onTyping, labels, recording, onClose }: Props) {
  const [, setTick] = useState(0);
  const [width, setWidth] = useState(600);
  const wrap = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, number>());

  useEffect(() => live.subscribe(() => setTick((x) => x + 1)), [live]);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(0, el.clientWidth - 16)); // minus the padding of .kb-main
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [target?.drum]);
  // notes held with the mouse end when the panel goes away
  useEffect(() => {
    const held = pointers.current;
    return () => {
      for (const n of held.values()) live.pitchOff(n);
      held.clear();
    };
  }, [live]);

  const base = 12 * (octave + 1);
  const keys = useMemo(() => {
    const whites = Math.max(8, Math.floor(width / WHITE_W));
    // one octave below the typing keys when there is room for it
    let lo = whites >= 22 ? base - 12 : base;
    lo = Math.max(0, Math.min(lo, 127 - 12));
    const out: { n: number; black: boolean; x: number }[] = [];
    let w = 0;
    for (let n = lo; n <= 127 && w < whites; n++) {
      if (isBlackKey(n)) out.push({ n, black: true, x: w * WHITE_W - BLACK_W / 2 });
      else {
        out.push({ n, black: false, x: w * WHITE_W });
        w++;
      }
    }
    // no black key hanging over the right edge
    while (out.length && out[out.length - 1].black) out.pop();
    return out;
  }, [width, base]);

  const noteAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const n = el?.closest<HTMLElement>('[data-n]')?.dataset.n;
    return n === undefined ? null : Number(n);
  };
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const n = noteAt(e.clientX, e.clientY);
    if (n === null) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable */
    }
    pointers.current.set(e.pointerId, n);
    live.pitchOn(n, velocity);
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const cur = pointers.current.get(e.pointerId);
    if (cur === undefined) return;
    const n = noteAt(e.clientX, e.clientY);
    if (n === null || n === cur) return;
    live.pitchOff(cur);
    pointers.current.set(e.pointerId, n);
    live.pitchOn(n, velocity);
  };
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    const cur = pointers.current.get(e.pointerId);
    if (cur === undefined) return;
    pointers.current.delete(e.pointerId);
    live.pitchOff(cur);
  };

  const active = new Set(live.notes());
  const activeKeys = new Set(live.keys());
  const label = (semi: number) => (typing && CODE_OF[semi] ? (labels[CODE_OF[semi]] ?? '') : '');

  return (
    <div className={`kb${recording ? ' rec' : ''}`}>
      <div className="kb-side">
        <div className="row" style={{ gap: 6 }}>
          <KeyboardIcon size={13} className="faint" />
          <b className="ellipsis grow" title={target ? `Plays ${target.inst}` : 'Select a track to play it'}>
            {target ? target.inst : 'no track'}
          </b>
          <button className="icon-mini" title="Hide the keyboard" onClick={onClose}>
            <X size={12} />
          </button>
        </div>
        {!target?.drum && (
          <div className="row" style={{ gap: 2 }}>
            <span className="small faint" style={{ width: 28 }}>
              Oct
            </span>
            <button className="icon-mini" title={`Octave down (${labels.KeyZ ?? 'Z'})`} disabled={octave <= 0} onClick={() => onOctave(octave - 1)}>
              <ChevronLeft size={13} />
            </button>
            <span className="mono small" style={{ width: 26, textAlign: 'center' }}>
              C{octave}
            </span>
            <button className="icon-mini" title={`Octave up (${labels.KeyX ?? 'X'})`} disabled={octave >= 8} onClick={() => onOctave(octave + 1)}>
              <ChevronRight size={13} />
            </button>
          </div>
        )}
        <div className="row" style={{ gap: 4 }} title={`Velocity of the on-screen and computer keyboard (${labels.KeyC ?? 'C'} / ${labels.KeyV ?? 'V'})`}>
          <span className="small faint" style={{ width: 28 }}>
            Vel
          </span>
          <input type="range" min={0.1} max={1} step={0.05} value={velocity} style={{ width: 74 }} onChange={(e) => onVelocity(Number(e.target.value))} />
          <span className="mono small faint">{Math.round(velocity * 127)}</span>
        </div>
        <div className="row" style={{ gap: 4 }}>
          <button
            className={`btn sm ghost kb-opt${typing ? ' on' : ''}`}
            onClick={() => onTyping(!typing)}
            title="Play with the computer keyboard: the letters on the keys, the two keys left of them change the octave, the next two the velocity"
          >
            Typing
          </button>
          {!target?.drum && (
            <button
              className={`btn sm ghost kb-opt${live.sustain ? ' on' : ''}`}
              onClick={() => live.pedal(!live.sustain)}
              title="Sustain: notes keep sounding after the key is released (like the pedal of a MIDI keyboard)"
            >
              Sustain
            </button>
          )}
        </div>
      </div>
      <div className="kb-main" ref={wrap}>
        {!target ? (
          <div className="faint small" style={{ padding: 14 }}>
            Select a track (or an instrument on the Instruments tab) to play it.
          </div>
        ) : target.drum ? (
          <div className="kb-pads">
            {target.sounds.slice(0, 36).map((s, i) => (
              <button
                key={s}
                className={`kb-pad${activeKeys.has(s) ? ' on' : ''}`}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  live.drumOn(s, velocity);
                }}
                onPointerUp={() => live.drumOff(s)}
                onPointerLeave={() => live.drumOff(s)}
                onPointerCancel={() => live.drumOff(s)}
                title={`${s}${target.noteOf.has(s) ? ` · MIDI key ${midiName(target.noteOf.get(s)!)} (${target.noteOf.get(s)})` : ''}`}
              >
                <span className="ellipsis">{s}</span>
                {label(i) && <kbd>{label(i)}</kbd>}
              </button>
            ))}
          </div>
        ) : (
          <div
            className="kb-keys"
            style={{ width: keys.filter((k) => !k.black).length * WHITE_W }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onContextMenu={(e) => e.preventDefault()}
          >
            {keys.map((k) => (
              <div
                key={k.n}
                data-n={k.n}
                className={`kb-key${k.black ? ' black' : ''}${active.has(k.n) ? ' on' : ''}`}
                style={{ left: k.x, width: k.black ? BLACK_W : WHITE_W }}
                title={midiName(k.n)}
              >
                {label(k.n - base) && <kbd>{label(k.n - base)}</kbd>}
                {!k.black && k.n % 12 === 0 && <span className="kb-c">{midiName(k.n)}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
