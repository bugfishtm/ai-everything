import { ExternalLink, Maximize, Monitor, RefreshCw, Smartphone, Tablet } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errMsg, type Project } from '../api';
import { socket } from '../ws';
import { Empty, Spinner } from './ui';

const SIZES = {
  full: { w: '100%', h: '100%' },
  tablet: { w: '820px', h: '1180px' },
  phone: { w: '390px', h: '844px' },
} as const;

export function PreviewPanel({ project, path: forcedPath }: { project: Project; path?: string | null }) {
  const [path, setPath] = useState(forcedPath || project.settings.previewPath || 'index.html');
  const [input, setInput] = useState(path);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [auto, setAuto] = useState(true);
  const [size, setSize] = useState<keyof typeof SIZES>('full');
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (forcedPath) {
      setPath(forcedPath);
      setInput(forcedPath);
    }
  }, [forcedPath]);

  const load = useCallback(async () => {
    try {
      const r = await api<{ url: string }>(`/projects/${project.id}/preview`, { body: { path } });
      setUrl(r.url);
      setError('');
    } catch (err) {
      setError(errMsg(err));
    }
  }, [project.id, path]);

  useEffect(() => {
    void load();
  }, [load]);

  // auto-reload when files change (Claude edits → preview updates)
  useEffect(() => {
    if (!auto) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = socket.on((msg) => {
      if (msg.t === 'project.changed' && msg.projectId === project.id) {
        clearTimeout(t);
        t = setTimeout(() => setVersion((v) => v + 1), 700);
      }
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [auto, project.id]);

  const src = url ? `${url}${url.includes('?') ? '&' : '?'}v=${version}` : null;
  const dims = SIZES[size];

  return (
    <div className="col" style={{ height: '100%', gap: 0 }}>
      <div className="preview-bar">
        <form
          className="row grow"
          onSubmit={(e) => {
            e.preventDefault();
            setPath(input.replace(/^\/+/, '') || 'index.html');
            setVersion((v) => v + 1);
          }}
        >
          <input className="input mono" style={{ height: 30, maxWidth: 380 }} value={input} onChange={(e) => setInput(e.target.value)} title="File inside the project to open" />
        </form>
        <button className="btn sm ghost icon" title="Reload" onClick={() => setVersion((v) => v + 1)}>
          <RefreshCw size={14} />
        </button>
        <label className="row small muted" style={{ gap: 6, cursor: 'pointer' }} title="Reload automatically when files change">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto reload
        </label>
        <span className="spacer" />
        <button className={`btn sm icon ${size === 'full' ? 'primary' : 'ghost'}`} onClick={() => setSize('full')} title="Full size">
          <Monitor size={14} />
        </button>
        <button className={`btn sm icon ${size === 'tablet' ? 'primary' : 'ghost'}`} onClick={() => setSize('tablet')} title="Tablet">
          <Tablet size={14} />
        </button>
        <button className={`btn sm icon ${size === 'phone' ? 'primary' : 'ghost'}`} onClick={() => setSize('phone')} title="Phone">
          <Smartphone size={14} />
        </button>
        <button className="btn sm ghost icon" title="Fullscreen" onClick={() => stage.current?.querySelector('iframe')?.requestFullscreen?.()}>
          <Maximize size={14} />
        </button>
        {src && (
          <a className="btn sm ghost icon" href={src} target="_blank" rel="noopener noreferrer" title="Open in a new tab">
            <ExternalLink size={14} />
          </a>
        )}
      </div>
      <div className={`preview-stage ${size !== 'full' ? 'device' : ''}`} ref={stage}>
        {error ? (
          <Empty title="Preview unavailable">{error}</Empty>
        ) : !src ? (
          <div className="center" style={{ width: '100%' }}>
            <Spinner />
          </div>
        ) : (
          <iframe
            key={src}
            src={src}
            title="Preview"
            style={{ width: dims.w, height: dims.h, flex: 'none' }}
            sandbox="allow-scripts allow-pointer-lock allow-popups allow-forms allow-modals allow-downloads"
            allow="fullscreen; gamepad; autoplay; clipboard-write; accelerometer; gyroscope"
          />
        )}
      </div>
    </div>
  );
}
