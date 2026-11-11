// Track headers of the pattern editor: one row per instrument playing in the pattern, with
// record-arm (where live playing and recording go), mute, solo and a level meter.
import { X } from 'lucide-react';
import { useCallback } from 'react';
import type { DawAudio } from './audio';
import { Meter } from './controls';
import type { DawPattern, SongModel } from './types';

interface Props {
  model: SongModel;
  pattern: DawPattern;
  patternName: string;
  sel: string | null;
  recording: boolean;
  audio: DawAudio;
  onSelect: (inst: string) => void;
  onMix: (inst: string, key: 'mute' | 'solo', on: boolean) => void;
  onRemove: (inst: string) => void;
  onAdd: (inst: string) => void;
}

export function TrackList({ model, pattern, patternName, sel, recording, audio, onSelect, onMix, onRemove, onAdd }: Props) {
  const tracks = Object.keys(pattern.tracks);
  const insts = Object.keys(model.instruments);
  const anySolo = insts.some((n) => model.mix[n]?.solo);
  return (
    <div className="trk-list">
      <div className="trk-scroll">
        {tracks.map((t) => (
          <TrackHead
            key={t}
            name={t}
            form={pattern.tracks[t].form}
            notes={pattern.tracks[t].events.length}
            describe={model.instruments[t]?.describe ?? 'unknown instrument'}
            drum={!!model.instruments[t]?.drum}
            mute={!!model.mix[t]?.mute}
            solo={!!model.mix[t]?.solo}
            silent={!!model.mix[t]?.mute || (anySolo && !model.mix[t]?.solo)}
            sel={t === sel}
            recording={recording && t === sel}
            removable={tracks.length > 1}
            patternName={patternName}
            audio={audio}
            onSelect={onSelect}
            onMix={onMix}
            onRemove={onRemove}
          />
        ))}
      </div>
      <select
        className="daw-input trk-add"
        value=""
        title="Add an instrument of the song to this pattern (new instruments: Instruments tab)"
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value);
        }}
      >
        <option value="">+ track…</option>
        {insts
          .filter((i) => !tracks.includes(i))
          .map((i) => (
            <option key={i}>{i}</option>
          ))}
      </select>
    </div>
  );
}

function TrackHead({
  name,
  form,
  notes,
  describe,
  drum,
  mute,
  solo,
  silent,
  sel,
  recording,
  removable,
  patternName,
  audio,
  onSelect,
  onMix,
  onRemove,
}: {
  name: string;
  form: string;
  notes: number;
  describe: string;
  drum: boolean;
  mute: boolean;
  solo: boolean;
  silent: boolean;
  sel: boolean;
  recording: boolean;
  removable: boolean;
  patternName: string;
  audio: DawAudio;
  onSelect: (inst: string) => void;
  onMix: (inst: string, key: 'mute' | 'solo', on: boolean) => void;
  onRemove: (inst: string) => void;
}) {
  const read = useCallback(() => audio.level(name), [audio, name]);
  return (
    <div className={`trk${sel ? ' sel' : ''}${silent ? ' silent' : ''}`} onClick={() => onSelect(name)} title={`${name}: ${describe}`}>
      <div className="trk-top">
        <span className="trk-name ellipsis">{name}</span>
        <span className="trk-form">{drum && form === 'grid' ? 'drums' : form}</span>
        {removable && (
          <button
            className="icon-mini"
            title={`Remove ${name} from ${patternName}`}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(name);
            }}
          >
            <X size={11} />
          </button>
        )}
      </div>
      <div className="trk-bottom">
        <button
          className={`ms arm${sel ? ' on' : ''}${recording ? ' rec' : ''}`}
          title={sel ? 'Armed: the keyboard, MIDI and Record go to this track' : 'Arm this track: play and record it with the keyboard / MIDI'}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(name);
          }}
        >
          R
        </button>
        <button
          className={`ms${mute ? ' on mute' : ''}`}
          title="Mute (saved in the song)"
          onClick={(e) => {
            e.stopPropagation();
            onMix(name, 'mute', !mute);
          }}
        >
          M
        </button>
        <button
          className={`ms${solo ? ' on solo' : ''}`}
          title="Solo (saved in the song)"
          onClick={(e) => {
            e.stopPropagation();
            onMix(name, 'solo', !solo);
          }}
        >
          S
        </button>
        <div className="trk-meter" title={`${notes} note${notes === 1 ? '' : 's'} in this pattern`}>
          <Meter read={read} vertical={false} />
        </div>
      </div>
    </div>
  );
}
