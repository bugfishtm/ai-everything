// Pieces of the transport bar: the position display, tap tempo, the MIDI device menu and the
// keyboard-shortcut help.
import { Cable } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../components/ui';
import type { DawAudio } from './audio';
import type { MidiIO } from './midiio';
import { formatTime, secToQ, songDuration } from './timeline';
import type { SongModel } from './types';

/** Bars.beats.sixteenths and the time, like the display of a hardware sequencer. */
export function Lcd({ model, audio, recording }: { model: SongModel; audio: DawAudio; recording: boolean }) {
  const pos = useRef<HTMLSpanElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = '';
    const beatLen = 4 / model.song.meter[1];
    const loop = () => {
      const t = audio.position();
      const left = audio.countInLeft();
      let text: string;
      if (left > 0) {
        const sec = model.sections.find((s) => t < s.startSec + (s.bars * model.song.barLen * 60) / s.bpm) ?? model.sections[model.sections.length - 1];
        const beatSec = (beatLen * 60) / (sec?.bpm ?? model.song.bpm);
        text = `count ${Math.max(1, Math.ceil(left / beatSec - 1e-6))}`;
      } else {
        const q = secToQ(model, Math.max(0, t));
        const bar = Math.floor(q / model.song.barLen + 1e-9);
        const inBar = q - bar * model.song.barLen;
        const beat = Math.floor(inBar / beatLen + 1e-9);
        const sub = Math.floor(((inBar - beat * beatLen) / beatLen) * 4 + 1e-9);
        text = `${String(bar + 1).padStart(3, ' ')}.${beat + 1}.${sub + 1}`;
      }
      const total = Math.max(songDuration(model), audio.duration - (model.song.tail ?? 0));
      const full = `${text}|${formatTime(t)} / ${formatTime(total)}`;
      if (full !== last) {
        last = full;
        if (pos.current) pos.current.textContent = text;
        if (time.current) time.current.textContent = `${formatTime(t)} / ${formatTime(total)}`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [model, audio]);
  return (
    <div className={`lcd${recording ? ' rec' : ''}`} title="Position: bar . beat . sixteenth — and the time">
      <span className="lcd-pos mono" ref={pos} />
      <span className="lcd-time mono" ref={time} />
    </div>
  );
}

/** Click in the tempo you hear in your head: the average of the last taps becomes the song tempo. */
export function TapTempo({ onTempo }: { onTempo: (bpm: number) => void }) {
  const taps = useRef<number[]>([]);
  const [flash, setFlash] = useState(false);
  return (
    <button
      className={`btn sm ghost tap${flash ? ' on' : ''}`}
      title="Tap tempo: click in time (4 or more taps are most exact)"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const now = performance.now();
        const list = taps.current;
        if (list.length && now - list[list.length - 1] > 2000) list.length = 0;
        list.push(now);
        if (list.length > 8) list.shift();
        setFlash(true);
        setTimeout(() => setFlash(false), 90);
        if (list.length < 2) return;
        const avg = (list[list.length - 1] - list[0]) / (list.length - 1);
        const bpm = Math.round(60000 / avg);
        if (bpm >= 20 && bpm <= 400) onTempo(bpm);
      }}
    >
      Tap
    </button>
  );
}

/** The MIDI button of the toolbar with its menu: connect, choose the input and the output. */
export function MidiMenu({ midi, onPanic, onFocusBack }: { midi: MidiIO; onPanic: () => void; onFocusBack: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const led = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let off: ReturnType<typeof setTimeout> | undefined;
    midi.onActivity = () => {
      led.current?.classList.add('hit');
      clearTimeout(off);
      off = setTimeout(() => led.current?.classList.remove('hit'), 110);
    };
    return () => {
      clearTimeout(off);
      midi.onActivity = undefined;
    };
  }, [midi]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const ready = midi.status === 'ready';
  const inName = midi.inputId === 'all' ? (midi.inputs.length === 1 ? midi.inputs[0].name : `${midi.inputs.length} inputs`) : midi.inputId === 'none' ? 'input off' : (midi.inputs.find((p) => p.id === midi.inputId)?.name ?? 'not connected');
  const label = !midi.supported ? 'MIDI n/a' : !ready ? 'MIDI' : midi.inputs.length ? inName : 'no device';
  const state = !midi.supported ? 'na' : ready ? (midi.activeInputs > 0 ? 'on' : 'idle') : midi.status === 'denied' || midi.status === 'error' ? 'err' : 'off';
  return (
    <div className="midi" ref={box}>
      <button
        className={`btn sm ghost midi-btn${open ? ' on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={
          !midi.supported
            ? midi.hint
            : ready
              ? `MIDI: ${midi.activeInputs} input${midi.activeInputs === 1 ? '' : 's'} playing the selected track${midi.output ? ` · output ${midi.output.name ?? ''}` : ''}`
              : 'MIDI keyboards and synths: click to connect'
        }
      >
        <span className={`midi-led ${state}`} ref={led} />
        <Cable size={13} />
        <span className="ellipsis midi-name">{label}</span>
      </button>
      {open && (
        <div className="midi-pop">
          <div className="midi-title">MIDI devices</div>
          {!midi.supported ? (
            <div className="notice warn small">{midi.hint}</div>
          ) : !ready ? (
            <>
              {(midi.status === 'denied' || midi.status === 'error') && <div className="notice warn small">{midi.hint}</div>}
              <div className="small faint">
                Play the selected track with a MIDI keyboard and record what you play. The browser asks once for permission to use your MIDI devices.
              </div>
              <button className="btn sm primary" disabled={midi.status === 'asking'} onClick={() => void midi.enable()}>
                <Cable size={13} /> {midi.status === 'asking' ? 'Waiting for the browser…' : midi.status === 'off' ? 'Connect MIDI devices' : 'Try again'}
              </button>
            </>
          ) : (
            <>
              <label className="small faint">Input (plays the selected track)</label>
              <select
                className="daw-input"
                value={midi.inputId}
                onChange={(e) => {
                  midi.setInput(e.target.value);
                  onFocusBack();
                }}
              >
                <option value="all">All inputs ({midi.inputs.length})</option>
                {midi.inputs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                {midi.inputId !== 'all' && midi.inputId !== 'none' && !midi.inputs.some((p) => p.id === midi.inputId) && <option value={midi.inputId}>(not connected)</option>}
                <option value="none">Off</option>
              </select>
              {!midi.inputs.length && <div className="small faint">No MIDI input found. Plug a keyboard in — it shows up here by itself.</div>}
              <label className="small faint">Output (gets what you play and the selected track while the song runs)</label>
              <select
                className="daw-input"
                value={midi.output ? midi.outputId : ''}
                onChange={(e) => {
                  midi.setOutput(e.target.value);
                  onFocusBack();
                }}
              >
                <option value="">None</option>
                {midi.outputs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <div className="row" style={{ gap: 6, marginTop: 2 }}>
                <button className="btn sm ghost" onClick={onPanic} title="End every sounding note here and on the MIDI output (all notes off)">
                  Panic
                </button>
                <span className="spacer" />
                <button className="btn sm ghost" onClick={() => midi.disable()} title="Stop using MIDI devices in this editor">
                  Disconnect
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const SHORTCUTS: [string, [string, string][]][] = [
  [
    'Transport',
    [
      ['Space', 'Play / pause'],
      ['Home', 'Back to the start (or the loop start)'],
      ['R', 'Record on / off (into the armed track)'],
      ['M', 'Metronome on / off'],
      ['L', 'Loop on / off (while Typing is off)'],
      ['Ctrl+Z · Ctrl+Y', 'Undo · redo (a recorded take is one step)'],
      ['Ctrl+S', 'Save the song'],
      ['?', 'This help'],
    ],
  ],
  [
    'Keyboard panel (Typing on)',
    [
      ['A S D F G H J K L', 'White keys from C'],
      ['W E   T Y U   O P', 'Black keys'],
      ['Z · X', 'Octave down · up'],
      ['C · V', 'Velocity down · up'],
    ],
  ],
  [
    'Piano roll (click into the grid first)',
    [
      ['Click · drag', 'Draw a note · set its length'],
      ['Shift+click · Ctrl+drag', 'Add to the selection · select with a box'],
      ['Drag · Alt+drag', 'Move · copy the selection'],
      ['Arrows', 'Move by one step / one semitone (Shift+Up/Down: an octave)'],
      ['Ctrl+C · Ctrl+X · Ctrl+V', 'Copy · cut · paste'],
      ['Ctrl+D · Ctrl+A', 'Duplicate · select all'],
      ['Q', 'Quantize the selection (or all) to the snap'],
      ['Del · right-click', 'Delete'],
      ['Ctrl+wheel', 'Zoom (also in the arrangement and the drum grid)'],
    ],
  ],
  [
    'Drum grid',
    [
      ['Click · drag', 'Set a hit · paint hits'],
      ['Shift · Alt + click', 'Accent · ghost note'],
      ['Wheel on a hit', 'Its velocity'],
      ['Right-click', 'Clear'],
    ],
  ],
];

export function ShortcutsDialog({ labels, onClose }: { labels: Record<string, string>; onClose: () => void }) {
  // the typing keys as they are printed on this computer's keyboard
  const local = (text: string) =>
    text
      .split(' ')
      .map((w) => (/^[A-Z]$/.test(w) ? (labels[`Key${w}`] ?? w) : w))
      .join(' ');
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} size="medium">
      <div className="keys-help">
        {SHORTCUTS.map(([group, rows]) => (
          <div key={group} className="keys-group">
            <h4>{group}</h4>
            {rows.map(([k, what]) => (
              <div key={k} className="keys-row">
                <kbd>{group.startsWith('Keyboard panel') ? local(k) : k}</kbd>
                <span>{what}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="small faint" style={{ marginTop: 12 }}>
        Shortcuts work while the DAW has the focus (click into it) and you are not typing in a text field.
      </div>
    </Modal>
  );
}
