import {
  ArrowLeft,
  Blocks,
  Box,
  Download,
  Globe,
  History,
  MessageSquare,
  PanelLeft,
  Play,
  Server,
  Settings,
  SlidersHorizontal,
  SquareTerminal,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, downloadUrl, errMsg, type Area, type PermissionMode, type Project, type Tool, type TreeNode } from '../api';
import { ChatPanel } from '../components/ChatPanel';
import { FileTree } from '../components/FileTree';
import { FileViewer } from '../components/FileViewer';
import { HistoryPanel } from '../components/HistoryPanel';
import { AddToLibraryModal, ProjectSettingsModal } from '../components/Modals';
import { PreviewPanel } from '../components/PreviewPanel';
import { ServicePanel } from '../components/ServicePanel';
import { SitePanel } from '../components/SitePanel';
import { TerminalView } from '../components/lazy';
import { WordPressPanel } from '../components/WordPressPanel';
import { AreaIcon, ContextMenu, Empty, FileIcon, Spinner, useUi, type MenuItem } from '../components/ui';
import { freeSongPath, STARTER } from '../daw/starter';
import { useProviderName, useStudio } from '../store';
import { basename, cls, PERMISSION_MODES } from '../util';
import { socket } from '../ws';

type FixedTab = 'chat' | 'claude' | 'shell' | 'preview' | 'wordpress' | 'server' | 'site' | 'history';

export function ProjectPage() {
  const { projectId } = useParams();
  const id = Number(projectId);
  const [search, setSearch] = useSearchParams();
  const [initialPrompt] = useState(() => search.get('prompt') ?? undefined);
  const ui = useUi();
  const { agents } = useStudio();
  const providerName = useProviderName();

  const [project, setProject] = useState<Project | null>(null);
  const [area, setArea] = useState<Area | undefined>();
  const [, setTools] = useState<Tool[]>([]);
  const [error, setError] = useState('');
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [tab, setTab] = useState<string>('chat');
  const [mounted, setMounted] = useState<Set<string>>(() => new Set(['chat']));
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [dirty, setDirty] = useState<Set<string>>(() => new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [showFiles, setShowFiles] = useState(() => window.innerWidth > 860);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addLib, setAddLib] = useState<string[] | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasServers, setHasServers] = useState(false);
  const [hasSite, setHasSite] = useState(false);
  const treeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // the Server tab shows in areas that usually need a backend, or when the project has one
  useEffect(() => {
    api<{ services: unknown[]; detected: unknown[] }>(`/projects/${id}/services`)
      .then((r) => setHasServers(r.services.length > 0 || r.detected.length > 0))
      .catch(() => {});
    const off = socket.on((m) => {
      if (m.t === 'services.changed' && m.projectId === id) setHasServers(true);
    });
    return off;
  }, [id]);
  // the Website tab: areas whose results are web pages, or projects that have a website
  useEffect(() => {
    api<{ site: unknown }>(`/projects/${id}/site`)
      .then((r) => setHasSite(!!r.site))
      .catch(() => {});
    const off = socket.on((m) => {
      if (m.t === 'sites.changed' && m.projectId === id) setHasSite(true);
    });
    return off;
  }, [id]);
  // the project's version in the title bar follows the History tab (a release, versioning on/off)
  const onVersion = useCallback((version: string | null) => {
    setProject((cur) => (cur && cur.version !== version ? { ...cur, version } : cur));
  }, []);
  // ?tab=server|site (links from the Servers and Websites pages)
  const wantTab = search.get('tab');

  useEffect(() => {
    if (search.has('prompt')) {
      search.delete('prompt');
      setSearch(search, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api<{ project: Project; area: Area; tools: Tool[] }>(`/projects/${id}`)
      .then((r) => {
        setProject(r.project);
        setArea(r.area);
        setTools(r.tools);
        setBusy(r.project.busy);
        document.title = `${r.project.name} · Everything Studio`;
      })
      .catch((err) => setError(errMsg(err)));
    return () => {
      document.title = 'Everything Studio';
    };
  }, [id]);

  // songs of the project (the DAW button opens them)
  const songs = useMemo(() => {
    const out: string[] = [];
    const walk = (n?: TreeNode) => {
      for (const c of n?.children ?? []) {
        if (c.type === 'file' && /\.song\.ya?ml$/i.test(c.name)) out.push(c.path);
        else if (c.type === 'dir' && !c.lazy && !c.name.startsWith('.') && c.name !== 'exports') walk(c);
      }
    };
    walk(tree ?? undefined);
    return out.sort((a, b) => Number(!a.startsWith('src/')) - Number(!b.startsWith('src/')) || a.localeCompare(b));
  }, [tree]);
  const [dawMenu, setDawMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  // scenes of the project (the 3D button opens them in the 3D editor)
  const scenes = useMemo(() => {
    const out: string[] = [];
    const walk = (n?: TreeNode) => {
      for (const c of n?.children ?? []) {
        if (c.type === 'file' && /\.scene\.ya?ml$/i.test(c.name)) out.push(c.path);
        else if (c.type === 'dir' && !c.lazy && !c.name.startsWith('.') && c.name !== 'exports') walk(c);
      }
    };
    walk(tree ?? undefined);
    return out.sort((a, b) => Number(!a.startsWith('src/')) - Number(!b.startsWith('src/')) || a.localeCompare(b));
  }, [tree]);

  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    try {
      setTree((await api<{ tree: TreeNode }>(`/projects/${id}/tree`)).tree);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setTreeLoading(false);
    }
  }, [id, ui]);

  useEffect(() => {
    void loadTree();
    const unsub = socket.subscribe(`project:${id}`);
    const off = socket.on((msg) => {
      if (msg.t === 'project.changed' && msg.projectId === id) {
        clearTimeout(treeTimer.current);
        treeTimer.current = setTimeout(() => {
          void loadTree();
          setRefreshKey((k) => k + 1);
        }, 400);
      } else if (msg.t === 'chat.status' && msg.projectId === id) {
        setBusy(msg.running);
      }
    });
    return () => {
      unsub();
      off();
      clearTimeout(treeTimer.current);
    };
  }, [id, loadTree]);

  const show = useCallback((t: string) => {
    setTab(t);
    setMounted((m) => (m.has(t) ? m : new Set(m).add(t)));
  }, []);

  useEffect(() => {
    if (wantTab === 'server' || wantTab === 'site' || wantTab === 'wordpress' || wantTab === 'history') {
      show(wantTab);
      if (wantTab === 'server') setHasServers(true);
      else if (wantTab === 'site') setHasSite(true);
      search.delete('tab');
      setSearch(search, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantTab, show]);

  const openFile = useCallback(
    (path: string) => {
      setOpenFiles((f) => (f.includes(path) ? f : [...f, path]));
      show(`file:${path}`);
      if (window.innerWidth <= 860) setShowFiles(false);
    },
    [show],
  );

  const closeFile = async (path: string) => {
    if (dirty.has(path)) {
      const ok = await ui.confirm({ title: 'Discard changes?', body: `${path} has unsaved changes.`, confirm: 'Discard', danger: true });
      if (!ok) return;
    }
    setOpenFiles((f) => f.filter((x) => x !== path));
    setDirty((d) => {
      const n = new Set(d);
      n.delete(path);
      return n;
    });
    setMounted((m) => {
      const n = new Set(m);
      n.delete(`file:${path}`);
      return n;
    });
    if (tab === `file:${path}`) setTab('chat');
  };

  const onDirty = useCallback((path: string, isDirty: boolean) => {
    setDirty((d) => {
      if (d.has(path) === isDirty) return d;
      const n = new Set(d);
      if (isDirty) n.add(path);
      else n.delete(path);
      return n;
    });
  }, []);

  const changeMode = async (mode: PermissionMode) => {
    if (!project) return;
    try {
      const r = await api<{ project: Project }>(`/projects/${project.id}`, { method: 'PATCH', body: { settings: { permissionMode: mode } } });
      setProject({ ...r.project, dir: project.dir });
      ui.toast(`AI permission mode: ${PERMISSION_MODES.find((m) => m.id === mode)?.label}`, 'info');
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  if (error) {
    return (
      <div className="page">
        <Empty title="Project not available">
          {error} — <Link to="/projects">back to projects</Link>
        </Empty>
      </div>
    );
  }
  if (!project) {
    return (
      <div className="center" style={{ height: '100%' }}>
        <Spinner size={22} />
      </div>
    );
  }

  const newSong = async () => {
    try {
      const target = await freeSongPath(project.id, 'src', 'song');
      await api(`/projects/${project.id}/file`, { method: 'PUT', body: { path: target, content: STARTER('Song') } });
      await loadTree();
      openFile(target);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };
  const openDaw = (e: React.MouseEvent) => {
    if (!songs.length) return void newSong();
    if (songs.length === 1) return openFile(songs[0]);
    setDawMenu({
      x: e.clientX,
      y: e.clientY + 14,
      items: [...songs.slice(0, 30).map((p) => ({ label: p, icon: <FileIcon name={p} size={14} />, onClick: () => openFile(p) })), { label: 'New song…', onClick: () => void newSong() }],
    });
  };
  const newScene = async () => {
    try {
      let target = 'src/scene.scene.yaml';
      for (let i = 2; scenes.includes(target); i++) target = `src/scene-${i}.scene.yaml`;
      await api(`/projects/${project.id}/tools/new`, { body: { path: target, template: 'basic' } });
      await loadTree();
      openFile(target);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };
  const open3d = (e: React.MouseEvent) => {
    if (!scenes.length) return void newScene();
    if (scenes.length === 1) return openFile(scenes[0]);
    setDawMenu({
      x: e.clientX,
      y: e.clientY + 14,
      items: [...scenes.slice(0, 30).map((p) => ({ label: p, icon: <FileIcon name={p} size={14} />, onClick: () => openFile(p) })), { label: 'New scene…', onClick: () => void newScene() }],
    });
  };
  const hasPreview = !!area?.previewPath || !!previewPath;
  // the project's AI (Claude Code, or another agent's own interactive UI in the terminal tab)
  const projectAi = project.settings.provider || agents?.prefs.defaultProvider || 'claude';
  const fixedTabs: { key: FixedTab; label: string; icon: React.ReactNode; hidden?: boolean }[] = [
    { key: 'chat', label: 'Chat', icon: <MessageSquare size={15} /> },
    { key: 'claude', label: `${providerName(projectAi)} terminal`, icon: <SquareTerminal size={15} /> },
    { key: 'shell', label: 'Shell', icon: <TerminalIcon size={15} /> },
    { key: 'preview', label: area?.id === 'game' ? 'Play' : 'Preview', icon: <Play size={15} />, hidden: !hasPreview },
    { key: 'wordpress', label: 'WordPress', icon: <Blocks size={15} />, hidden: !area?.wordpress },
    { key: 'server', label: 'Server', icon: <Server size={15} />, hidden: !area?.services && !hasServers },
    { key: 'site', label: 'Website', icon: <Globe size={15} />, hidden: !area?.sites && !hasSite },
    { key: 'history', label: 'History', icon: <History size={15} /> },
  ];
  const selectedFile = tab.startsWith('file:') ? tab.slice(5) : null;

  return (
    <div className="ws" style={{ ['--area' as string]: area?.color }}>
      <div className="ws-top">
        <Link to={`/area/${project.area}`} className="btn ghost icon sm" title="Back">
          <ArrowLeft size={16} />
        </Link>
        <button className={cls('btn sm icon', showFiles ? 'primary' : 'ghost')} onClick={() => setShowFiles(!showFiles)} title="Toggle files">
          <PanelLeft size={15} />
        </button>
        <span className="area-icon" style={{ width: 28, height: 28, borderRadius: 8 }}>
          <AreaIcon icon={area?.icon ?? 'sparkles'} size={15} />
        </span>
        <div className="col" style={{ gap: 0, minWidth: 0 }}>
          <span className="ws-title ellipsis">{project.name}</span>
          <span className="faint small">{area?.name}</span>
        </div>
        {project.version && (
          <button className="badge accent" style={{ cursor: 'pointer' }} onClick={() => show('history')} title="The version of this project — releases are in the History tab">
            v{project.version}
          </button>
        )}
        {busy && (
          <span className="busy-pill">
            <Spinner size={12} /> {projectAi === 'claude' ? 'Claude' : 'The AI'} is working
          </span>
        )}
        <span className="spacer" />
        {(area?.id === 'music' || songs.length > 0) && (
          <button className="btn sm" onClick={openDaw} title={songs.length ? 'Open a song in the DAW (arrangement, piano roll, mixer, exports)' : 'Create a song and open it in the DAW'}>
            <SlidersHorizontal size={15} /> DAW
          </button>
        )}
        {(area?.id === 'model3d' || scenes.length > 0) && (
          <button className="btn sm" onClick={open3d} title={scenes.length ? 'Open a scene in the 3D editor (move, shape, materials, textures, exports)' : 'Create a scene and open it in the 3D editor'}>
            <Box size={15} /> 3D editor
          </button>
        )}
        <select
          className="select"
          style={{ width: 'auto', height: 30, fontSize: 13 }}
          value={project.settings.permissionMode}
          onChange={(e) => void changeMode(e.target.value as PermissionMode)}
          title={PERMISSION_MODES.find((m) => m.id === project.settings.permissionMode)?.hint}
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {project.settings.model && <span className="badge">{project.settings.model}</span>}
        <a className="btn sm ghost icon" href={downloadUrl(project.id)} title="Download project as zip">
          <Download size={15} />
        </a>
        <button className="btn sm ghost icon" onClick={() => setSettingsOpen(true)} title="Project settings">
          <Settings size={15} />
        </button>
      </div>

      <div className="ws-body" style={{ position: 'relative' }}>
        <aside className={cls('ws-side', !showFiles && 'hidden')}>
          <FileTree
            projectId={project.id}
            tree={tree}
            loading={treeLoading}
            selected={selectedFile}
            onOpen={openFile}
            onRefresh={() => void loadTree()}
            onAddToLibrary={(paths) => setAddLib(paths)}
            onDeleted={(p) => setOpenFiles((f) => f.filter((x) => x !== p && !x.startsWith(`${p}/`)))}
          />
        </aside>

        <section className="ws-main">
          <div className="tabs ws-tabs">
            {fixedTabs
              .filter((t) => !t.hidden)
              .map((t) => (
                <button key={t.key} className={cls('tab', tab === t.key && 'active')} onClick={() => show(t.key)}>
                  {t.icon}
                  {t.label}
                </button>
              ))}
            {openFiles.map((f) => (
              <button key={f} className={cls('tab', tab === `file:${f}` && 'active')} onClick={() => show(`file:${f}`)} title={f}>
                <FileIcon name={f} size={14} />
                {basename(f)}
                {dirty.has(f) && <span style={{ color: 'var(--warn)' }}>●</span>}
                <span
                  className="x"
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeFile(f);
                  }}
                >
                  <X size={12} />
                </span>
              </button>
            ))}
          </div>

          <div className="ws-panel">
            {mounted.has('chat') && (
              <div className="panel" hidden={tab !== 'chat'}>
                <ChatPanel project={project} area={area} initialPrompt={initialPrompt} onOpenHistory={() => show('history')} />
              </div>
            )}
            {mounted.has('claude') && (
              <div className="panel" hidden={tab !== 'claude'}>
                <TerminalView
                  kind="claude"
                  projectId={project.id}
                  provider={projectAi}
                  title={projectAi === 'claude' ? 'claude — interactive Claude Code in this project' : `${providerName(projectAi)} — its own interactive terminal in this project`}
                />
              </div>
            )}
            {mounted.has('shell') && (
              <div className="panel" hidden={tab !== 'shell'}>
                <TerminalView kind="shell" projectId={project.id} title="bash — your sandbox account" />
              </div>
            )}
            {mounted.has('preview') && hasPreview && (
              <div className="panel" hidden={tab !== 'preview'}>
                <PreviewPanel project={project} path={previewPath} />
              </div>
            )}
            {mounted.has('wordpress') && (
              <div className="panel" hidden={tab !== 'wordpress'}>
                <WordPressPanel project={project} onOpenFile={openFile} />
              </div>
            )}
            {mounted.has('server') && (
              <div className="panel" hidden={tab !== 'server'}>
                <ServicePanel project={project} />
              </div>
            )}
            {mounted.has('site') && (
              <div className="panel" hidden={tab !== 'site'}>
                <SitePanel project={project} />
              </div>
            )}
            {mounted.has('history') && (
              <div className="panel" hidden={tab !== 'history'}>
                <HistoryPanel project={{ ...project, busy }} onVersion={onVersion} />
              </div>
            )}
            {openFiles.map(
              (f) =>
                mounted.has(`file:${f}`) && (
                  <div key={f} className="panel" hidden={tab !== `file:${f}`}>
                    <FileViewer
                      projectId={project.id}
                      path={f}
                      refreshKey={refreshKey}
                      onDirty={onDirty}
                      onAddToLibrary={(paths) => setAddLib(paths)}
                      onPreview={(p) => {
                        setPreviewPath(p);
                        show('preview');
                      }}
                      projectDir={project.dir}
                      onOpenFile={openFile}
                    />
                  </div>
                ),
            )}
          </div>
        </section>
      </div>

      {dawMenu && <ContextMenu x={dawMenu.x} y={dawMenu.y} items={dawMenu.items} onClose={() => setDawMenu(null)} />}
      {settingsOpen && <ProjectSettingsModal project={project} onClose={() => setSettingsOpen(false)} onSaved={setProject} />}
      {addLib && <AddToLibraryModal project={project} paths={addLib} onClose={() => setAddLib(null)} />}
    </div>
  );
}
