import { Box, CircleAlert, CircleCheck, X } from 'lucide-react';
import { rawUrl } from '../api';

export interface ToolAction {
  label: string;
  action: string;
  primary?: boolean;
}

/** Buttons the file viewer shows for Studio text formats. */
export function toolActionsFor(path: string): ToolAction[] {
  if (/\.song\.ya?ml$/i.test(path))
    return [
      { label: 'Check', action: 'daw.check' },
      { label: 'Render', action: 'daw.render', primary: true },
    ];
  if (/\.scene\.ya?ml$/i.test(path))
    return [
      { label: 'Check', action: '3d.check' },
      { label: 'Build', action: '3d.build', primary: true },
    ];
  if (/\.stick\.ya?ml$/i.test(path))
    return [
      { label: 'Check', action: 'stick.check' },
      { label: 'Draft', action: 'stick.draft' },
      { label: 'Render', action: 'stick.render', primary: true },
    ];
  if (/\.image\.ya?ml$/i.test(path))
    return [
      { label: 'Check', action: 'image.check' },
      { label: 'Render', action: 'image.render', primary: true },
    ];
  if (/\.video\.ya?ml$/i.test(path))
    return [
      { label: 'Check', action: 'video.check' },
      { label: 'Draft', action: 'video.draft' },
      { label: 'Render', action: 'video.render', primary: true },
    ];
  return [];
}

export interface RunResultData {
  ok: boolean;
  code: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  report: any;
  output: string;
}

export function RunResult({
  result,
  projectId,
  projectDir,
  onOpenFile,
  onClose,
}: {
  result: RunResultData;
  projectId: number;
  projectDir?: string;
  onOpenFile?: (path: string) => void;
  onClose: () => void;
}) {
  const r = result.report;
  const rel = (p?: string) => (p && projectDir && p.startsWith(projectDir + '/') ? p.slice(projectDir.length + 1) : p);
  const v = Date.now();
  const files = (r?.files ?? {}) as Record<string, string>;
  const audio = rel(files.mp3 || files.wav);
  const preview = rel(files.preview);
  const glb = rel(files.glb);
  const video = rel(files.mp4);
  const warnings: string[] = r?.warnings ?? [];
  // studio-image: every file it wrote
  const exported: { file: string; size: number[]; bytes: number }[] = Array.isArray(r?.exports) && typeof r.exports[0] === 'object' ? r.exports : [];
  const sounds = r?.audio?.sfx ?? (r?.audio?.clips ?? 0) + (r?.audio?.sounds ?? 0);

  return (
    <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-1)', padding: '10px 14px', maxHeight: '55%', overflow: 'auto' }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {result.ok ? <CircleCheck size={18} color="var(--ok)" /> : <CircleAlert size={18} color="var(--danger)" />}
        <div className="grow">
          {!result.ok ? (
            <>
              <b>Failed</b>
              <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', color: '#fecaca' }}>
                {r?.error ?? result.output}
              </pre>
            </>
          ) : r?.lufs !== undefined ? (
            <b>
              Rendered {r.seconds}s · {r.lufs} LUFS · peak {r.peak_dbfs} dBFS · {r.render_seconds}s
            </b>
          ) : r?.stats ? (
            <b>
              {r.files ? 'Built' : 'OK'} · {r.stats.triangles.toLocaleString()} triangles · {r.objects} objects
              {r.stats.bounds ? ` · ${r.stats.bounds.size.map((n: number) => n.toFixed(2)).join(' × ')} m` : ''}
            </b>
          ) : r?.frames !== undefined ? (
            <b>
              Rendered {r.seconds}s · {r.frames} frames at {r.fps} fps · {r.size?.join('×')}
              {r.draft ? ' (draft)' : ''} · {sounds} sounds · {r.render_seconds}s
            </b>
          ) : r?.analysis ? (
            <b>
              Rendered {r.size?.join('×')} · {r.layers} layer(s) · {exported.length} file(s)
              {r.analysis.brightness !== undefined ? ` · brightness ${r.analysis.brightness}, contrast ${r.analysis.contrast}` : ' · completely transparent'} · {r.render_seconds}s
            </b>
          ) : r?.clips !== undefined ? (
            <b>
              OK · {r.seconds}s at {r.fps} fps · {r.size?.join('×')} · {r.clips} clip(s) · {r.overlays} overlay(s) · {r.sounds} sound(s)
            </b>
          ) : r?.layers !== undefined ? (
            <b>
              OK · {r.size?.join('×')} · {r.layers} layer(s)
            </b>
          ) : r?.figures && !Array.isArray(r.figures) ? (
            <b>
              OK · {r.seconds}s at {r.fps} fps · {Object.keys(r.figures).length} figure(s) · {r.events} events
            </b>
          ) : (
            <b>OK{r?.bars !== undefined ? ` · ${r.bars} bars, ${r.seconds}s` : ''}</b>
          )}
          {warnings.length > 0 && (
            <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--warn)' }}>
              {warnings.slice(0, 12).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
        <button className="btn ghost sm icon" onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </div>
      {result.ok && exported.length > 0 && (
        <div className="row wrap small" style={{ marginTop: 8, gap: 6 }}>
          {exported.slice(0, 16).map((e) => {
            const p = rel(e.file) ?? e.file;
            return (
              <button key={e.file} className="chip" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => onOpenFile?.(p)} title={`${e.size?.join('×')} px · ${(e.bytes / 1024).toFixed(1)} KB`}>
                {p.split('/').pop()}
              </button>
            );
          })}
        </div>
      )}
      {result.ok && (audio || preview || glb || video) && (
        <div className="row wrap" style={{ marginTop: 10, alignItems: 'flex-start', gap: 14 }}>
          {video && (
            <video
              controls
              autoPlay
              src={`${rawUrl(projectId, video)}?v=${v}`}
              style={{ maxWidth: 'min(100%, 560px)', maxHeight: 320, borderRadius: 8, border: '1px solid var(--border)', background: '#000' }}
            />
          )}
          {audio && <audio controls src={`${rawUrl(projectId, audio)}?v=${v}`} style={{ width: 360 }} />}
          {glb && onOpenFile && (
            <button className="btn sm" onClick={() => onOpenFile(glb)}>
              <Box size={14} /> Open {glb}
            </button>
          )}
          {preview && <img src={`${rawUrl(projectId, preview)}?v=${v}`} alt="preview" style={{ maxWidth: '100%', maxHeight: 360, borderRadius: 8, border: '1px solid var(--border)' }} />}
        </div>
      )}
    </div>
  );
}
