import { ChevronDown, ChevronRight, ChevronUp, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { DawAudio } from './audio';
import { Fader, Knob, Meter, NumField, ParamControl, PeakReadout } from './controls';
import { LIVE_EFFECTS, type Catalog, type EffectSpec, type ParamSpec, type SongModel } from './types';

export type FxTarget = { inst: string } | { master: true };

interface Props {
  model: SongModel;
  catalog: Catalog | null;
  audio: DawAudio;
  selInst: string | null;
  onSelectInst: (inst: string) => void;
  onMix: (inst: string, key: string, value: unknown, done: boolean) => void;
  onMaster: (key: string, value: unknown) => void;
  onFxAdd: (t: FxTarget, use: string) => void;
  onFxRemove: (t: FxTarget, i: number) => void;
  onFxMove: (t: FxTarget, from: number, to: number) => void;
  onFxParam: (t: FxTarget, i: number, key: string, value: unknown, done: boolean) => void;
  monitor: number;
  onMonitor: (v: number) => void;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function EffectList({ list, target, catalog, props }: { list: EffectSpec[]; target: FxTarget; catalog: Catalog | null; props: Props }) {
  const [open, setOpen] = useState<number | null>(null);
  const effects = catalog?.effects ?? [];
  return (
    <div className="fx-list">
      {list.map((fx, i) => {
        const def = effects.find((e) => e.name === fx.use);
        const live = LIVE_EFFECTS.has(fx.use);
        const params = { ...(def?.params ?? {}), ...Object.fromEntries(Object.entries(fx).filter(([k]) => k !== 'use')) };
        return (
          <div key={i} className="fx-item">
            <div className="fx-head">
              <button className="icon-mini" onClick={() => setOpen(open === i ? null : i)}>
                {open === i ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              </button>
              <span className="ellipsis grow" title={def ? `${def.doc} [${def.source}]` : 'unknown effect'}>
                {fx.use}
              </span>
              {!live && (
                <span className="fx-badge" title={def ? `${def.source} — not playable live in the browser; use Render to hear it exactly` : 'unknown effect'}>
                  {def ? 'render' : '?'}
                </span>
              )}
              <button className="icon-mini" title="Earlier" disabled={i === 0} onClick={() => props.onFxMove(target, i, i - 1)}>
                <ChevronUp size={11} />
              </button>
              <button className="icon-mini" title="Remove" onClick={() => props.onFxRemove(target, i)}>
                <X size={11} />
              </button>
            </div>
            {open === i && (
              <div className="fx-params">
                {Object.entries(params).map(([k, v]) => {
                  if (fx.use === 'sidechain' && k === 'source') {
                    return (
                      <div key={k} className="param param-wide">
                        <span className="small">source</span>
                        <select className="daw-input" value={String(v)} onChange={(e) => props.onFxParam(target, i, k, e.target.value, true)}>
                          {[...new Set([String(v), ...Object.keys(props.model.instruments)])].map((n) => (
                            <option key={n}>{n}</option>
                          ))}
                        </select>
                      </div>
                    );
                  }
                  const spec: ParamSpec = def?.specs?.[k] ?? { type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'text', min: 0, max: 1 };
                  return (
                    <ParamControl
                      key={k}
                      name={k}
                      value={v}
                      spec={spec}
                      def={def?.params?.[k]}
                      overridden={k in fx}
                      onChange={(val, done) => props.onFxParam(target, i, k, val, done)}
                      onReset={() => props.onFxParam(target, i, k, undefined, true)}
                    />
                  );
                })}
                {!Object.keys(params).length && <span className="small faint">no parameters</span>}
              </div>
            )}
          </div>
        );
      })}
      <select
        className="daw-input fx-add"
        value=""
        onChange={(e) => {
          if (e.target.value) props.onFxAdd(target, e.target.value);
        }}
      >
        <option value="">+ effect…</option>
        <optgroup label="Built-in">
          {effects
            .filter((e) => e.source === 'built-in')
            .map((e) => (
              <option key={e.name} value={e.name} title={e.doc}>
                {e.name}
              </option>
            ))}
        </optgroup>
        {effects.some((e) => e.source !== 'built-in') && (
          <optgroup label="Plugins (render)">
            {effects
              .filter((e) => e.source !== 'built-in')
              .map((e) => (
                <option key={e.name} value={e.name} title={`${e.doc} — ${e.source}`}>
                  {e.name}
                </option>
              ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}

export function Mixer(props: Props) {
  const { model, audio } = props;
  const insts = Object.keys(model.instruments);
  const anySolo = insts.some((n) => model.mix[n]?.solo);
  const master = model.master;
  const readMaster = useCallback(() => audio.level(), [audio]);
  const readL = useCallback(() => audio.masterLevel(0), [audio]);
  const readR = useCallback(() => audio.masterLevel(1), [audio]);
  return (
    <div className="mixer">
      {insts.map((name) => (
        <Strip key={name} name={name} {...props} anySolo={anySolo} />
      ))}
      <div className="strip master">
        <div className="strip-name">master</div>
        <div className="strip-row">
          <Knob value={props.monitor} spec={{ min: 0, max: 1.5 }} label="listen" def={0.8} onChange={(v) => props.onMonitor(v)} title="Speaker volume while editing (not saved)" />
        </div>
        <div className="strip-fader" title="Level of the left and right channel after the limiter of the live preview (the line holds the peak)">
          <MeterScale />
          <Meter read={readL} />
          <Meter read={readR} />
        </div>
        <div className="strip-db">
          peak <PeakReadout read={readMaster} />
        </div>
        <label className="small faint">target LUFS</label>
        <NumField value={master.target === null ? undefined : num(master.target, -14)} min={-40} max={-4} width={70} onChange={(v) => props.onMaster('target', v)} title="loudness the mix is normalized to (empty = -14)" />
        <label className="small faint">ceiling dB</label>
        <NumField value={num(master.ceiling, -1)} min={-12} max={0} width={70} onChange={(v) => props.onMaster('ceiling', v)} />
        <label className="small faint">fade out s</label>
        <NumField value={master.fade_out} min={0} max={60} width={70} onChange={(v) => props.onMaster('fade_out', v || undefined)} />
        <EffectList list={master.effects ?? []} target={{ master: true }} catalog={props.catalog} props={props} />
      </div>
    </div>
  );
}

/** dB marks next to a meter. */
function MeterScale() {
  return (
    <div className="meter-scale">
      {[0, -6, -12, -24, -36, -48].map((db) => (
        <span key={db} style={{ bottom: `${((db + 54) / 54) * 100}%` }}>
          {db}
        </span>
      ))}
    </div>
  );
}

function Strip({ name, anySolo, ...props }: Props & { name: string; anySolo: boolean }) {
  const { model, audio } = props;
  const ins = model.instruments[name];
  const mix = model.mix[name] ?? { effects: [] };
  const read = useCallback(() => audio.level(name), [audio, name]);
  const gain = num(mix.gain ?? mix.volume, 0);
  const silent = !!mix.mute || (anySolo && !mix.solo);
  return (
    <div className={`strip${props.selInst === name ? ' sel' : ''}${silent ? ' silent' : ''}`}>
      <button className="strip-name" title={`${name}: ${ins.describe}`} onClick={() => props.onSelectInst(name)}>
        {name}
      </button>
      <div className="strip-kind ellipsis" title={ins.describe}>
        {ins.voice ?? ins.kind}
        {ins.source?.startsWith('project:') && <span className="plug" title={ins.source}> ★</span>}
      </div>
      <div className="strip-row">
        <button className={`ms${mix.mute ? ' on mute' : ''}`} onClick={() => props.onMix(name, 'mute', !mix.mute || undefined, true)} title="Mute (saved in the song)">
          M
        </button>
        <button className={`ms${mix.solo ? ' on solo' : ''}`} onClick={() => props.onMix(name, 'solo', !mix.solo || undefined, true)} title="Solo (saved in the song)">
          S
        </button>
      </div>
      <div className="strip-row">
        <Knob value={num(mix.pan, 0)} spec={{ min: -1, max: 1, step: 0.01 }} label="pan" def={0} bipolar onChange={(v, done) => props.onMix(name, 'pan', v || undefined, done)} />
      </div>
      <div className="strip-fader">
        <Fader db={gain} onChange={(v, done) => props.onMix(name, 'gain', v, done)} />
        <Meter read={read} />
      </div>
      <div className="strip-db" title="Fader position · peak level since the last click on it">
        {gain > 0 ? '+' : ''}{gain} dB <PeakReadout read={read} />
      </div>
      <div className="strip-row">
        <Knob value={num(mix.reverb, 0)} spec={{ min: 0, max: 1, step: 0.01 }} label="rev" def={0} size={28} onChange={(v, done) => props.onMix(name, 'reverb', v || undefined, done)} />
        <Knob value={num(mix.delay, 0)} spec={{ min: 0, max: 1, step: 0.01 }} label="dly" def={0} size={28} onChange={(v, done) => props.onMix(name, 'delay', v || undefined, done)} />
      </div>
      <EffectList list={mix.effects ?? []} target={{ inst: name }} catalog={props.catalog} props={props} />
    </div>
  );
}
