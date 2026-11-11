import {
  AudioLines,
  Box,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Download,
  Film,
  Image as ImageIcon,
  Ellipsis,
  FilePlus,
  FolderPlus,
  FolderUp,
  Library,
  Package,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCallback, useRef, useState, type DragEvent, type MouseEvent as RMouseEvent } from 'react';
import { api, downloadUrl, errMsg, upload, type TreeNode } from '../api';
import { cls, dirname, formatBytes } from '../util';
import { ContextMenu, FileIcon, Spinner, useUi, type MenuItem } from './ui';

interface Props {
  projectId: number;
  tree: TreeNode | null;
  loading: boolean;
  selected: string | null;
  onOpen: (path: string) => void;
  onRefresh: () => void;
  onAddToLibrary: (paths: string[]) => void;
  onDeleted?: (path: string) => void;
}

interface Picked {
  file: File;
  path: string;
}

async function filesFromDrop(dt: DataTransfer): Promise<Picked[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return [...dt.files].map((f) => ({ file: f, path: f.name }));
  const out: Picked[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

export function FileTree({ projectId, tree, loading, selected, onOpen, onRefresh, onAddToLibrary, onDeleted }: Props) {
  const ui = useUi();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['src', 'exports', 'assets']));
  const [lazy, setLazy] = useState<Record<string, TreeNode[]>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode | null } | null>(null);
  const [drop, setDrop] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const uploadDir = useRef('');

  const toggle = useCallback(
    async (node: TreeNode) => {
      const open = !expanded.has(node.path);
      setExpanded((s) => {
        const n = new Set(s);
        if (open) n.add(node.path);
        else n.delete(node.path);
        return n;
      });
      if (open && node.lazy && !lazy[node.path]) {
        try {
          const r = await api<{ tree: TreeNode }>(`/projects/${projectId}/tree?path=${encodeURIComponent(node.path)}`);
          setLazy((l) => ({ ...l, [node.path]: r.tree.children ?? [] }));
        } catch (err) {
          ui.toast(errMsg(err), 'error');
        }
      }
    },
    [expanded, lazy, projectId, ui],
  );

  const doUpload = async (files: Picked[], dir: string) => {
    if (!files.length) return;
    const form = new FormData();
    for (const f of files) form.append('files', f.file, f.path);
    setUploading(0);
    try {
      const r = await upload<{ saved: string[]; errors: string[] }>(`/projects/${projectId}/upload?dir=${encodeURIComponent(dir)}`, form, setUploading);
      if (r.errors.length) ui.toast(r.errors.join('\n'), 'error');
      if (r.saved.length) ui.toast(`Uploaded ${r.saved.length} file${r.saved.length === 1 ? '' : 's'}`);
      if (dir) setExpanded((s) => new Set(s).add(dir));
      onRefresh();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setUploading(null);
    }
  };

  const newFile = async (dir: string) => {
    const name = await ui.prompt('New file', '', dir ? `in ${dir}/` : 'in the project root');
    if (!name) return;
    const path = dir ? `${dir}/${name}` : name;
    try {
      // songs, 3D scenes and stick scenes start from the tool's starter — an empty file would not even pass Check
      if (/\.(song|scene|stick|image|video)\.ya?ml$/i.test(name)) await api(`/projects/${projectId}/tools/new`, { body: { path } });
      else await api(`/projects/${projectId}/file`, { method: 'PUT', body: { path, content: '' } });
      if (dir) setExpanded((s) => new Set(s).add(dir));
      onRefresh();
      onOpen(path);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };
  /** A new song / 3D scene / stick animation from one of the tool's templates. */
  const newFromStarter = async (dir: string, kind: { label: string; suffix: string; templates: string[] }) => {
    const base = dir || 'src';
    const name = await ui.prompt(`New ${kind.label}`, `my-${kind.label.split(' ').pop()}`, `File name — saved as ${base}/<name>${kind.suffix}`);
    if (!name) return;
    const clean = name.trim().replace(/\.(song|scene|stick|image|video)\.ya?ml$/i, '').replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/\s+/g, '-');
    if (!clean) return;
    let template: string | undefined;
    if (kind.templates.length > 1) {
      const t = await ui.prompt('Start from', kind.templates[0], `Template: ${kind.templates.join(' · ')}`);
      if (t === null) return;
      template = t.trim().toLowerCase() || undefined;
    }
    const path = `${base}/${clean}${kind.suffix}`;
    try {
      await api(`/projects/${projectId}/tools/new`, { body: { path, ...(template ? { template } : {}) } });
      setExpanded((s) => new Set(s).add(base));
      onRefresh();
      onOpen(path);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };
  const newFolder = async (dir: string) => {
    const name = await ui.prompt('New folder', '', dir ? `in ${dir}/` : 'in the project root');
    if (!name) return;
    try {
      await api(`/projects/${projectId}/fs/mkdir`, { body: { path: dir ? `${dir}/${name}` : name } });
      if (dir) setExpanded((s) => new Set(s).add(dir));
      onRefresh();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };
  const rename = async (node: TreeNode) => {
    const name = await ui.prompt('Rename', node.name);
    if (!name || name === node.name) return;
    const parent = dirname(node.path);
    try {
      await api(`/projects/${projectId}/fs/move`, { body: { from: node.path, to: parent ? `${parent}/${name}` : name } });
      onRefresh();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };
  const remove = async (node: TreeNode) => {
    const ok = await ui.confirm({
      title: `Delete ${node.type === 'dir' ? 'folder' : 'file'}?`,
      body: (
        <>
          <b>{node.path}</b> will be deleted. Committed versions stay in the project history.
        </>
      ),
      confirm: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/projects/${projectId}/fs/delete`, { body: { path: node.path } });
      onDeleted?.(node.path);
      onRefresh();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  const installPack = async (path: string) => {
    try {
      const r = await api<{ pack: { id: string; name: string; itemCount: number } }>('/packs/install', { body: { projectId, path } });
      ui.toast(
        <>
          Installed pack “{r.pack.name}” ({r.pack.itemCount} items) — use it as <code>{r.pack.id}/…</code>. <a href={`/packs?pack=user:${r.pack.id}`}>Open</a>
        </>,
      );
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  const menuItems = (node: TreeNode | null): MenuItem[] => {
    const dir = node ? (node.type === 'dir' ? node.path : dirname(node.path)) : '';
    const items: MenuItem[] = [];
    if (!node || node.type === 'dir') {
      items.push(
        { label: 'New file', icon: <FilePlus size={15} />, onClick: () => newFile(dir) },
        { label: 'New folder', icon: <FolderPlus size={15} />, onClick: () => newFolder(dir) },
        {
          label: 'New song',
          icon: <AudioLines size={15} />,
          onClick: () => newFromStarter(dir, { label: 'song', suffix: '.song.yaml', templates: ['basic', 'gm', 'ambient', 'lofi', 'chiptune', 'house'] }),
        },
        {
          label: 'New 3D scene',
          icon: <Box size={15} />,
          onClick: () => newFromStarter(dir, { label: '3D scene', suffix: '.scene.yaml', templates: ['basic', 'props', 'terrain', 'organic'] }),
        },
        {
          label: 'New stick animation',
          icon: <Clapperboard size={15} />,
          onClick: () => newFromStarter(dir, { label: 'stick animation', suffix: '.stick.yaml', templates: ['fight', 'talk', 'dance', 'blank'] }),
        },
        {
          label: 'New picture',
          icon: <ImageIcon size={15} />,
          onClick: () => newFromStarter(dir, { label: 'picture', suffix: '.image.yaml', templates: ['poster', 'icon', 'pixel', 'texture', 'banner', 'blank'] }),
        },
        {
          label: 'New video',
          icon: <Film size={15} />,
          onClick: () => newFromStarter(dir, { label: 'video', suffix: '.video.yaml', templates: ['trailer', 'slideshow', 'social', 'blank'] }),
        },
        {
          label: 'Upload files here',
          icon: <Upload size={15} />,
          onClick: () => {
            uploadDir.current = dir;
            fileInput.current?.click();
          },
        },
      );
    }
    if (node) {
      if (items.length) items.push({ label: '', divider: true, onClick: () => {} });
      if (node.type === 'file') items.push({ label: 'Open', icon: <FileIcon name={node.name} />, onClick: () => onOpen(node.path) });
      items.push(
        {
          label: node.type === 'dir' ? 'Download as zip' : 'Download',
          icon: <Download size={15} />,
          onClick: () => window.open(downloadUrl(projectId, node.path), '_blank'),
        },
        { label: 'Add to library…', icon: <Library size={15} />, onClick: () => onAddToLibrary([node.path]) },
        ...(node.type === 'dir'
          ? [{ label: 'Install as pack', icon: <Package size={15} />, onClick: () => installPack(node.path) }]
          : []),
        { label: 'Rename', icon: <Pencil size={15} />, onClick: () => rename(node) },
        { label: '', divider: true, onClick: () => {} },
        { label: 'Delete', icon: <Trash2 size={15} />, danger: true, onClick: () => remove(node) },
      );
    }
    return items;
  };

  const openMenu = (e: RMouseEvent, node: TreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  const renderNodes = (nodes: TreeNode[], depth: number) =>
    nodes.map((n) => {
      const open = expanded.has(n.path);
      const children = n.children ?? lazy[n.path];
      return (
        <div key={n.path}>
          <div
            className={cls('tnode', selected === n.path && 'sel')}
            style={{ paddingLeft: 6 + depth * 14 }}
            onClick={() => (n.type === 'dir' ? toggle(n) : onOpen(n.path))}
            onContextMenu={(e) => openMenu(e, n)}
            title={n.path}
          >
            {n.type === 'dir' ? (
              open ? <ChevronDown size={14} /> : <ChevronRight size={14} />
            ) : (
              <span style={{ width: 14, flex: 'none' }} />
            )}
            <FileIcon name={n.name} dir={n.type === 'dir'} open={open} link={n.type === 'link'} />
            <span className="name">{n.name}</span>
            {n.type === 'file' && n.size !== undefined && <span className="size">{formatBytes(n.size)}</span>}
            <button className="btn ghost sm icon more" onClick={(e) => openMenu(e, n)} aria-label="More">
              <Ellipsis size={14} />
            </button>
          </div>
          {n.type === 'dir' && open && (
            <div>
              {children ? renderNodes(children, depth + 1) : <div className="faint small" style={{ paddingLeft: 30 + depth * 14 }}>loading…</div>}
              {children && !children.length && <div className="faint small" style={{ paddingLeft: 34 + depth * 14 }}>empty</div>}
            </div>
          )}
        </div>
      );
    });

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDrop(false);
    const files = await filesFromDrop(e.dataTransfer);
    await doUpload(files, '');
  };

  return (
    <>
      <div className="tree-tools">
        <span className="muted small" style={{ fontWeight: 600, paddingLeft: 4 }}>
          FILES
        </span>
        <span className="spacer" />
        {uploading !== null && (
          <span className="small faint row">
            <Spinner size={12} /> {uploading}%
          </span>
        )}
        <button className="btn ghost sm icon" title="New file" onClick={() => newFile('')}>
          <FilePlus size={15} />
        </button>
        <button className="btn ghost sm icon" title="New folder" onClick={() => newFolder('')}>
          <FolderPlus size={15} />
        </button>
        <button
          className="btn ghost sm icon"
          title="Upload files"
          onClick={() => {
            uploadDir.current = '';
            fileInput.current?.click();
          }}
        >
          <Upload size={15} />
        </button>
        <button
          className="btn ghost sm icon"
          title="Upload a folder"
          onClick={() => {
            uploadDir.current = '';
            folderInput.current?.click();
          }}
        >
          <FolderUp size={15} />
        </button>
        <button className="btn ghost sm icon" title="Refresh" onClick={onRefresh}>
          {loading ? <Spinner size={14} /> : <RefreshCw size={14} />}
        </button>
      </div>
      <div
        className={cls('tree', drop && 'drop')}
        onContextMenu={(e) => openMenu(e, null)}
        onDragOver={(e) => {
          e.preventDefault();
          setDrop(true);
        }}
        onDragLeave={() => setDrop(false)}
        onDrop={onDrop}
      >
        {tree?.children ? renderNodes(tree.children, 0) : <div className="faint small" style={{ padding: 12 }}>loading…</div>}
        <div className="faint small" style={{ padding: '14px 10px' }}>
          Drop files here to upload
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])].map((f) => ({ file: f, path: f.name }));
          e.target.value = '';
          void doUpload(files, uploadDir.current);
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        // @ts-expect-error non-standard but widely supported
        webkitdirectory=""
        onChange={(e) => {
          const files = [...(e.target.files ?? [])].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
          e.target.value = '';
          void doUpload(files, uploadDir.current);
        }}
      />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.node)} onClose={() => setMenu(null)} />}
    </>
  );
}
