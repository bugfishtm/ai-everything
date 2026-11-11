// Import a MIDI file as a song (also used from the file viewer for .mid files — loaded on demand).
import { useMemo, useState } from 'react';
import { errMsg } from '../api';
import { Modal } from '../components/ui';
import { midiToSong, parseMidi } from './midi';
import type { Catalog } from './types';

export default function MidiImportDialog({ file, catalog, onClose, onDone }: { file: { name: string; buf: ArrayBuffer }; catalog: Catalog | null; onClose: () => void; onDone: (text: string) => void }) {
  const [quantize, setQuantize] = useState(0.25);
  const [chunk, setChunk] = useState(8);
  const [gm, setGm] = useState(true);
  const info = useMemo(() => {
    try {
      const mf = parseMidi(file.buf);
      return { mf, error: null as string | null };
    } catch (err) {
      return { mf: null, error: errMsg(err) };
    }
  }, [file]);
  const hasGm = !!catalog?.packs.some((p) => p.use.startsWith('gm-instruments/'));
  return (
    <Modal
      title={`Import ${file.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!info.mf}
            onClick={() => {
              try {
                onDone(midiToSong(info.mf!, file.name, catalog, { quantize, chunkBars: chunk, useGm: gm && hasGm }));
              } catch (err) {
                alert(errMsg(err));
              }
            }}
          >
            Import as song
          </button>
        </>
      }
    >
      {info.error ? (
        <div className="notice error">{info.error}</div>
      ) : (
        info.mf && (
          <>
            <div className="small muted" style={{ marginBottom: 12 }}>
              {info.mf.tracks.filter((t) => t.notes.length).length} tracks with notes · {Math.round((60_000_000 / info.mf.tempo) * 10) / 10} bpm · {info.mf.meter.join('/')}
            </div>
            <div className="form-grid">
              <label>Snap notes to</label>
              <select className="daw-input" value={quantize} onChange={(e) => setQuantize(Number(e.target.value))} style={{ width: 200 }}>
                <option value={0.25}>1/16 (recommended)</option>
                <option value={0.125}>1/32</option>
                <option value={1 / 6}>1/16 triplets</option>
                <option value={0}>keep timing (1/48)</option>
              </select>
              <label>Sections of</label>
              <select className="daw-input" value={chunk} onChange={(e) => setChunk(Number(e.target.value))} style={{ width: 200 }}>
                <option value={4}>4 bars</option>
                <option value={8}>8 bars</option>
                <option value={16}>16 bars</option>
                <option value={0}>one section</option>
              </select>
              <label>Instruments</label>
              <label className="row small" style={{ gap: 6 }}>
                <input type="checkbox" checked={gm && hasGm} disabled={!hasGm} onChange={(e) => setGm(e.target.checked)} />
                General MIDI SoundFont sounds {hasGm ? '' : '(gm-instruments pack not installed)'}
              </label>
            </div>
            <div className="small faint" style={{ marginTop: 12 }}>
              Repeated parts become shared patterns. The song is saved next to this one and opens in a new tab.
            </div>
          </>
        )
      )}
    </Modal>
  );
}

