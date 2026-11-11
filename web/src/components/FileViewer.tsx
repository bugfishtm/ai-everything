import { Box, Code2, Download, Eye, Library, Play, Save, SlidersHorizontal } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api, downloadUrl, errMsg, rawUrl, type FileContent } from '../api';
import { freeSongPath } from '../daw/starter';
import type { Catalog } from '../daw/types';
import { basename, dirname, ext, formatBytes, viewKind } from '../util';
import { CodeEditor, DawEditor, ModelViewer, SceneEditor } from './lazy';
import { Markdown } from './Markdown';
import { RunResult, type RunResultData, toolActionsFor } from './RunTool';
import { Empty, FileIcon, Spinner, useUi } from './ui';

interface Props {
  projectId: number;
  path: string;
  refreshKey: number;
  onDirty: (path: string, dirty: boolean) => void;
  onAddToLibrary: (paths: string[]) => void;
  onPreview?: (path: string) => void;
  projectDir?: string;
  onOpenFile?: (path: string) => void;
}

const DUAL = new Set(['md', 'svg', 'gltf', 'obj', 'html', 'htm']);
const MidiImport = lazy(() => import('../daw/MidiImport'));

/** CodeMirror normalizes line breaks to \n — compare and edit in that form. */
const toLf = (s: string) => s.replace(/\r\n?/g, '\n');

export function FileViewer({ projectId, path, refreshKey, onDirty, onAddToLibrary, onPreview, projectDir, onOpenFile }: Props) {
  const ui = useUi();
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunResultData | null>(null);
  const actions = toolActionsFor(path);
  const e = ext(path);
  const kind = viewKind(path);
  const isSong = /\.song\.ya?ml$/i.test(path);
  const isScene = /\.scene\.ya?ml$/i.test(path);
  const [mode, setMode] = useState<'view' | 'code' | 'daw' | '3d'>(isSong ? 'daw' : isScene ? '3d' : e === 'html' || e === 'htm' ? 'code' : 'view');
  const isMidi = e === 'mid' || e === 'midi';
  const [midi, setMidi] = useState<{ name: string; buf: ArrayBuffer } | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const openMidi = async () => {
    try {
      const res = await fetch(rawUrl(projectId, path), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMidi({ name: basename(path), buf: await res.arrayBuffer() });
      api<Catalog>(`/projects/${projectId}/daw/catalog`)
        .then(setCatalog)
        .catch(() => {});
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  const load = useCallback(async () => {
    try {
      const f = await api<FileContent>(`/projects/${projectId}/file?path=${encodeURIComponent(path)}`);
      setFile(f);
      // the editor works with \n; remember the file's own line endings for saving
      setText(toLf(f.text ?? ''));
      setDirty(false);
      setError('');
    } catch (err) {
      setError(errMsg(err));
    }
  }, [projectId, path]);

  useEffect(() => {
    void load();
  }, [load]);

  // reload on outside changes (Claude edited the file) unless the user has unsaved edits
  useEffect(() => {
    if (refreshKey && !dirty) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => onDirty(path, dirty), [dirty, path, onDirty]);

  const save = useCallback(async () => {
    if (!file || file.binary) return;
    setSaving(true);
    try {
      const content = /\r\n/.test(file.text ?? '') ? text.replace(/\n/g, '\r\n') : text;
      await api(`/projects/${projectId}/file`, { method: 'PUT', body: { path, content } });
      setFile({ ...file, text: content }); // the saved text is the new baseline for "unsaved"
      setDirty(false);
      ui.toast(`Saved ${path}`);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setSaving(false);
    }
  }, [file, projectId, path, text, ui]);

  const runTool = async (action: string) => {
    setRunning(action);
    try {
      if (dirty) await save();
      setRunResult(await api<RunResultData>(`/projects/${projectId}/tools/run`, { body: { action, path } }));
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setRunning(null);
    }
  };

  if (error) return <Empty title="Cannot open file">{error}</Empty>;
  if (!file) {
    return (
      <div className="center" style={{ height: '100%' }}>
        <Spinner />
      </div>
    );
  }

  const url = `${rawUrl(projectId, path)}?v=${Math.round(file.mtime)}`;
  const isText = !file.binary && !file.tooLarge;
  const canView = kind !== 'text' || e === 'md';
  const showCode = isText && (!canView || mode === 'code');

  let body: React.ReactNode;
  if (isSong && isText && mode === 'daw') {
    body = (
      <DawEditor
        projectId={projectId}
        path={path}
        text={text}
        onChange={(v) => {
          setText(v);
          setDirty(v !== toLf(file.text ?? ''));
        }}
        onSave={save}
        refreshKey={refreshKey}
        onOpenFile={onOpenFile}
      />
    );
  } else if (isScene && isText && mode === '3d') {
    body = (
      <SceneEditor
        projectId={projectId}
        path={path}
        text={text}
        onChange={(v) => {
          setText(v);
          setDirty(v !== toLf(file.text ?? ''));
        }}
        onSave={save}
        refreshKey={refreshKey}
        onOpenFile={onOpenFile}
      />
    );
  } else if (showCode) {
    body = (
      <CodeEditor
        path={path}
        value={text}
        onChange={(v) => {
          setText(v);
          setDirty(v !== toLf(file.text ?? ''));
        }}
        onSave={save}
      />
    );
  } else if (kind === 'image') {
    body = (
      <div className="viewer-media">
        <img src={url} alt={path} className={file.size < 20000 && e !== 'svg' ? 'pixel' : ''} />
      </div>
    );
  } else if (kind === 'audio') {
    body = (
      <div className="audio-box">
        <FileIcon name={path} size={48} />
        <div className="muted">{path}</div>
        <audio controls src={url} />
      </div>
    );
  } else if (kind === 'video') {
    body = (
      <div className="viewer-media">
        <video controls src={url} />
      </div>
    );
  } else if (kind === 'model') {
    body = <ModelViewer url={url} fileName={path} projectId={projectId} onOpenFile={onOpenFile} />;
  } else if (e === 'md' && isText) {
    body = (
      <div className="doc-pad">
        <Markdown text={text} />
      </div>
    );
  } else {
    body = (
      <Empty title={file.tooLarge ? 'File too large to edit here' : 'Binary file'}>
        {formatBytes(file.size)} · {file.mime}
        <div style={{ marginTop: 12 }}>
          <a className="btn" href={downloadUrl(projectId, path)}>
            <Download size={15} /> Download
          </a>
        </div>
      </Empty>
    );
  }

  return (
    <div className="col" style={{ height: '100%', gap: 0 }}>
      <div className="viewer-head">
        <FileIcon name={path} />
        <span className="ellipsis mono small" title={path}>
          {path}
        </span>
        {dirty && <span className="badge warn">unsaved</span>}
        <span className="faint small">{formatBytes(file.size)}</span>
        <span className="spacer" />
        {isText && isSong && (
          <div className="row" style={{ gap: 2 }}>
            <button className={`btn sm ${mode === 'daw' ? 'primary' : 'ghost'}`} onClick={() => setMode('daw')} title="Edit the song in the DAW (arrangement, piano roll, drum grid, mixer)">
              <SlidersHorizontal size={14} /> DAW
            </button>
            <button className={`btn sm ${mode !== 'daw' ? 'primary' : 'ghost'}`} onClick={() => setMode('code')} title="Edit the song text">
              <Code2 size={14} /> Code
            </button>
          </div>
        )}
        {isText && isScene && (
          <div className="row" style={{ gap: 2 }}>
            <button className={`btn sm ${mode === '3d' ? 'primary' : 'ghost'}`} onClick={() => setMode('3d')} title="Edit the scene in the 3D editor (move, shape, materials, textures)">
              <Box size={14} /> 3D editor
            </button>
            <button className={`btn sm ${mode !== '3d' ? 'primary' : 'ghost'}`} onClick={() => setMode('code')} title="Edit the scene text">
              <Code2 size={14} /> Code
            </button>
          </div>
        )}
        {isText && DUAL.has(e) && (
          <div className="row" style={{ gap: 2 }}>
            <button className={`btn sm ${mode === 'view' ? 'primary' : 'ghost'}`} onClick={() => setMode('view')}>
              <Eye size={14} /> View
            </button>
            <button className={`btn sm ${mode === 'code' ? 'primary' : 'ghost'}`} onClick={() => setMode('code')}>
              <Code2 size={14} /> Code
            </button>
          </div>
        )}
        {isMidi && (
          <button className="btn sm" onClick={() => void openMidi()} title="Turn this MIDI file into a song and edit it in the DAW">
            <SlidersHorizontal size={14} /> Open in DAW
          </button>
        )}
        {(e === 'html' || e === 'htm') && onPreview && (
          <button className="btn sm" onClick={() => onPreview(path)}>
            <Play size={14} /> Preview
          </button>
        )}
        <button className="btn sm ghost" onClick={() => onAddToLibrary([path])} title="Add to library">
          <Library size={14} /> Library
        </button>
        <a className="btn sm ghost icon" href={downloadUrl(projectId, path)} title="Download">
          <Download size={14} />
        </a>
        {!(isSong && mode === 'daw') && !(isScene && mode === '3d') && actions.map((a) => (
          <button key={a.action} className={`btn sm ${a.primary ? '' : 'ghost'}`} disabled={!!running} onClick={() => void runTool(a.action)} title={`studio ${a.action.replace('.', ' ')}`}>
            {running === a.action ? <Spinner size={14} /> : a.primary ? <Play size={14} /> : null} {a.label}
          </button>
        ))}
        {isText && (
          <button className="btn sm primary" disabled={!dirty || saving} onClick={save} title="Save (Ctrl+S)">
            {saving ? <Spinner size={14} /> : <Save size={14} />} Save
          </button>
        )}
      </div>
      {runResult && (
        <RunResult result={runResult} projectId={projectId} projectDir={projectDir} onOpenFile={onOpenFile} onClose={() => setRunResult(null)} />
      )}
      <div className="viewer-body">{body}</div>
      {midi && (
        <Suspense fallback={null}>
          <MidiImport
            file={midi}
            catalog={catalog}
            onClose={() => setMidi(null)}
            onDone={async (songText) => {
              try {
                const target = await freeSongPath(projectId, dirname(path) === 'exports' || !dirname(path) ? 'src' : dirname(path), midi.name);
                await api(`/projects/${projectId}/file`, { method: 'PUT', body: { path: target, content: songText } });
                setMidi(null);
                ui.toast(`Imported ${midi.name} → ${target}`);
                onOpenFile?.(target);
              } catch (err) {
                ui.toast(errMsg(err), 'error');
              }
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
