import {
  AudioLines,
  Blocks,
  Box,
  Clapperboard,
  CircleAlert,
  CircleCheck,
  Code,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Gamepad2,
  Globe,
  Image,
  Info,
  Link,
  LoaderCircle,
  Monitor,
  Music,
  Package,
  Smartphone,
  Sparkles,
  Type,
  X,
  type LucideIcon,
} from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ext } from '../util';

// ---------------------------------------------------------------------------
export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" />;
}

export function Empty({ icon: Icon = Package, title, children }: { icon?: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon size={34} strokeWidth={1.5} />
      <div style={{ fontWeight: 600, color: 'var(--text)' }}>{title}</div>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
const AREA_ICONS: Record<string, LucideIcon> = {
  music: Music,
  image: Image,
  box: Box,
  clapperboard: Clapperboard,
  gamepad: Gamepad2,
  smartphone: Smartphone,
  monitor: Monitor,
  globe: Globe,
  blocks: Blocks,
  sparkles: Sparkles,
};
export function AreaIcon({ icon, size = 20 }: { icon: string; size?: number }) {
  const I = AREA_ICONS[icon] ?? Sparkles;
  return <I size={size} />;
}

const KIND_ICONS: Record<string, LucideIcon> = {
  model3d: Box,
  image: Image,
  audio: AudioLines,
  music: Music,
  video: Clapperboard,
  font: Type,
  code: Code,
  document: FileText,
  other: Package,
};
export function KindIcon({ kind, size = 18 }: { kind: string; size?: number }) {
  const I = KIND_ICONS[kind] ?? Package;
  return <I size={size} />;
}

export function FileIcon({ name, dir, open, link, size = 15 }: { name: string; dir?: boolean; open?: boolean; link?: boolean; size?: number }) {
  if (link) return <Link size={size} />;
  if (dir) return open ? <FolderOpen size={size} color="#8b9bb8" /> : <Folder size={size} color="#8b9bb8" />;
  const e = ext(name);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(e)) return <FileImage size={size} color="#fb923c" />;
  if (['wav', 'mp3', 'ogg', 'flac', 'm4a', 'mid', 'midi', 'opus'].includes(e)) return <FileAudio size={size} color="#f472b6" />;
  if (['mp4', 'webm', 'mov', 'mkv'].includes(e)) return <FileVideo size={size} color="#f87171" />;
  if (['glb', 'gltf', 'obj', 'stl', 'fbx', 'ply'].includes(e)) return <Box size={size} color="#60a5fa" />;
  if (['zip', 'apk', 'exe', 'tar', 'gz', '7z'].includes(e)) return <FileArchive size={size} color="#fbbf24" />;
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'cs', 'kt', 'java', 'c', 'cpp', 'h', 'html', 'css', 'json', 'sh', 'xml', 'gradle', 'kts', 'toml', 'yml', 'yaml', 'glsl'].includes(e))
    return <FileCode size={size} color="#a3e635" />;
  if (['md', 'txt'].includes(e)) return <FileText size={size} />;
  return <File size={size} />;
}

// ---------------------------------------------------------------------------
export function Modal({
  title,
  onClose,
  children,
  footer,
  size,
  icon,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'wide' | 'medium';
  icon?: ReactNode;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return createPortal(
    <div
      className="modal-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal ${size ?? ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          {icon}
          <h2 className="grow ellipsis">{title}</h2>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
type ToastKind = 'ok' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: ReactNode;
}
interface ConfirmReq {
  title: string;
  body?: ReactNode;
  confirm?: string;
  danger?: boolean;
  resolve: (v: boolean) => void;
}
interface UiApi {
  toast: (text: ReactNode, kind?: ToastKind) => void;
  confirm: (opts: Omit<ConfirmReq, 'resolve'>) => Promise<boolean>;
  prompt: (title: string, initial?: string, label?: string) => Promise<string | null>;
}
const UiCtx = createContext<UiApi | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null);
  const [promptReq, setPromptReq] = useState<{ title: string; label?: string; value: string; resolve: (v: string | null) => void } | null>(null);
  const nextId = useRef(1);

  const toast = useCallback((text: ReactNode, kind: ToastKind = 'ok') => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  const confirm = useCallback(
    (opts: Omit<ConfirmReq, 'resolve'>) => new Promise<boolean>((resolve) => setConfirmReq({ ...opts, resolve })),
    [],
  );
  const prompt = useCallback(
    (title: string, initial = '', label?: string) =>
      new Promise<string | null>((resolve) => setPromptReq({ title, label, value: initial, resolve })),
    [],
  );

  // one stable object: pages load data in effects that depend on `ui` — a new object per toast
  // made them reload on every toast (and loop while the server was unreachable: error → toast → reload)
  const uiApi = useMemo<UiApi>(() => ({ toast, confirm, prompt }), [toast, confirm, prompt]);

  return (
    <UiCtx.Provider value={uiApi}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'error' ? <CircleAlert size={18} color="var(--danger)" /> : t.kind === 'ok' ? <CircleCheck size={18} color="var(--ok)" /> : <Info size={18} />}
            <div className="grow">{t.text}</div>
          </div>
        ))}
      </div>
      {confirmReq && (
        <Modal
          title={confirmReq.title}
          onClose={() => {
            confirmReq.resolve(false);
            setConfirmReq(null);
          }}
          footer={
            <>
              <button
                className="btn"
                onClick={() => {
                  confirmReq.resolve(false);
                  setConfirmReq(null);
                }}
              >
                Cancel
              </button>
              <button
                className={`btn ${confirmReq.danger ? 'danger' : 'primary'}`}
                autoFocus
                onClick={() => {
                  confirmReq.resolve(true);
                  setConfirmReq(null);
                }}
              >
                {confirmReq.confirm ?? 'OK'}
              </button>
            </>
          }
        >
          <div className="muted">{confirmReq.body}</div>
        </Modal>
      )}
      {promptReq && (
        <Modal
          title={promptReq.title}
          onClose={() => {
            promptReq.resolve(null);
            setPromptReq(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              promptReq.resolve(promptReq.value);
              setPromptReq(null);
            }}
          >
            <div className="field">
              {promptReq.label && <label className="label">{promptReq.label}</label>}
              <input
                className="input"
                autoFocus
                value={promptReq.value}
                onChange={(e) => setPromptReq({ ...promptReq, value: e.target.value })}
                onFocus={(e) => {
                  const v = e.target.value;
                  const dot = v.lastIndexOf('.');
                  e.target.setSelectionRange(0, dot > 0 ? dot : v.length);
                }}
              />
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  promptReq.resolve(null);
                  setPromptReq(null);
                }}
              >
                Cancel
              </button>
              <button type="submit" className="btn primary">
                OK
              </button>
            </div>
          </form>
        </Modal>
      )}
    </UiCtx.Provider>
  );
}

export function useUi(): UiApi {
  const v = useContext(UiCtx);
  if (!v) throw new Error('UiProvider missing');
  return v;
}

// ---------------------------------------------------------------------------
export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  onClick: () => void;
  divider?: boolean;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
    }
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => window.addEventListener('mousedown', close), 0);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [x, y, onClose]);
  return createPortal(
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) =>
        it.divider ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            className={it.danger ? 'danger' : ''}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            {it.icon}
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
