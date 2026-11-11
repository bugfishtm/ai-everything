// Project lists (the area pages and "Projects"): search, sorting, a grid or a list with details,
// pinned projects first, an archive for the ones that are done.
import { Archive, ArrowUpDown, Ellipsis, Globe, LayoutGrid, LayoutList, MessageSquare, Pencil, Pin, PinOff, Search, Server, Tag, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, type Project } from '../api';
import { useStudio } from '../store';
import { cls, timeAgo } from '../util';
import { AreaIcon, ContextMenu, useUi, type MenuItem } from './ui';

type SortKey = 'opened' | 'changed' | 'name' | 'name-desc' | 'newest' | 'oldest' | 'version';
type View = 'grid' | 'list';

const SORTS: { id: SortKey; label: string }[] = [
  { id: 'opened', label: 'Last opened' },
  { id: 'changed', label: 'Last changed' },
  { id: 'name', label: 'Name A–Z' },
  { id: 'name-desc', label: 'Name Z–A' },
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'version', label: 'Version' },
];

function stored<T extends string>(key: string, allowed: readonly T[], def: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : def;
  } catch {
    return def;
  }
}
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

const time = (d: string | null | undefined) => (d ? new Date(d).getTime() : 0);

function versionParts(v: string | null): number[] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1];
}

function compare(a: Project, b: Project, sort: SortKey): number {
  switch (sort) {
    case 'name':
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    case 'name-desc':
      return b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' });
    case 'newest':
      return time(b.createdAt) - time(a.createdAt);
    case 'oldest':
      return time(a.createdAt) - time(b.createdAt);
    case 'changed':
      return time(b.updatedAt) - time(a.updatedAt);
    case 'version': {
      const [x, y] = [versionParts(a.version), versionParts(b.version)];
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2] || a.name.localeCompare(b.name);
    }
    default:
      return time(b.lastOpenedAt ?? b.createdAt) - time(a.lastOpenedAt ?? a.createdAt);
  }
}

export function ProjectCard({ p, onMenu }: { p: Project; onMenu?: (e: React.MouseEvent, p: Project) => void }) {
  const { areas } = useStudio();
  const a = areas.find((x) => x.id === p.area);
  return (
    <Link to={`/p/${p.id}`} className={cls('project-card', p.archived && 'archived')} onContextMenu={onMenu ? (e) => onMenu(e, p) : undefined}>
      <div className="row">
        <span className="area-icon" style={{ ['--area' as string]: a?.color ?? '#94a3b8', width: 30, height: 30, borderRadius: 8 }}>
          <AreaIcon icon={a?.icon ?? 'sparkles'} size={15} />
        </span>
        <b className="grow ellipsis">{p.name}</b>
        {p.pinned && <Pin size={13} color="var(--accent)" style={{ flex: 'none' }} />}
        {p.version && <span className="badge">v{p.version}</span>}
        {p.busy && <span className="busy-pill">working</span>}
        {onMenu && (
          <button
            className="btn ghost icon sm card-menu"
            title="More"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onMenu(e, p);
            }}
          >
            <Ellipsis size={15} />
          </button>
        )}
      </div>
      {p.description ? <p>{p.description}</p> : <p className="faint">{a?.name}</p>}
      <div className="faint small">
        opened {timeAgo(p.lastOpenedAt ?? p.createdAt)}
        {p.archived ? ' · archived' : ''}
      </div>
    </Link>
  );
}

export function ProjectBrowser({
  projects,
  showArea,
  toolbarExtra,
  filter,
  empty,
  onChange,
}: {
  projects: Project[];
  /** lists that mix areas show which one a project belongs to */
  showArea?: boolean;
  /** more filters next to the search (area chips) */
  toolbarExtra?: React.ReactNode;
  filter?: (p: Project) => boolean;
  empty: React.ReactNode;
  /** a project was changed (pinned, renamed …) or removed (null) */
  onChange: (id: number, next: Project | null) => void;
}) {
  const ui = useUi();
  const { areas, refreshAreas } = useStudio();
  const [q, setQ] = useState('');
  const [sort, setSortState] = useState<SortKey>(() => stored('studio.projects.sort', SORTS.map((s) => s.id), 'opened'));
  const [view, setViewState] = useState<View>(() => stored('studio.projects.view', ['grid', 'list'] as const, 'grid'));
  const [showArchived, setShowArchived] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const setSort = (s: SortKey) => (setSortState(s), store('studio.projects.sort', s));
  const setView = (v: View) => (setViewState(v), store('studio.projects.view', v));

  const scoped = useMemo(() => projects.filter((p) => !filter || filter(p)), [projects, filter]);
  const archivedCount = scoped.filter((p) => p.archived).length;
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return scoped
      .filter((p) => (showArchived ? p.archived : !p.archived))
      .filter((p) => {
        if (!words.length) return true;
        const hay = `${p.name} ${p.description} ${p.version ? `v${p.version}` : ''} ${areas.find((a) => a.id === p.area)?.name ?? ''}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || compare(a, b, sort));
  }, [scoped, q, sort, showArchived, areas]);

  const patch = async (p: Project, body: Record<string, unknown>, done?: string) => {
    try {
      const r = await api<{ project: Project }>(`/projects/${p.id}`, { method: 'PATCH', body });
      onChange(p.id, { ...p, ...r.project });
      if (done) ui.toast(done);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  const openMenu = (e: React.MouseEvent, p: Project) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        p.pinned
          ? { label: 'Unpin', icon: <PinOff size={14} />, onClick: () => void patch(p, { settings: { pinned: false } }) }
          : { label: 'Pin to the top', icon: <Pin size={14} />, onClick: () => void patch(p, { settings: { pinned: true } }) },
        {
          label: 'Rename…',
          icon: <Pencil size={14} />,
          onClick: async () => {
            const name = await ui.prompt('Rename project', p.name, 'Name');
            if (name?.trim() && name.trim() !== p.name) void patch(p, { name: name.trim() });
          },
        },
        p.archived
          ? { label: 'Take out of the archive', icon: <Archive size={14} />, onClick: () => void patch(p, { settings: { archived: false } }, 'Back in the list') }
          : {
              label: 'Archive',
              icon: <Archive size={14} />,
              onClick: () => void patch(p, { settings: { archived: true, pinned: false } }, 'Archived — find it with “Archived” above the list'),
            },
        {
          label: 'Delete…',
          icon: <Trash2 size={14} />,
          danger: true,
          onClick: async () => {
            const ok = await ui.confirm({
              title: `Delete “${p.name}”?`,
              body: 'The project is moved to the trash and deleted for good after a few days. Assets you saved to the library stay.',
              confirm: 'Delete project',
              danger: true,
            });
            if (!ok) return;
            try {
              await api(`/projects/${p.id}`, { method: 'DELETE' });
              onChange(p.id, null);
              void refreshAreas();
              ui.toast('Project deleted');
            } catch (err) {
              ui.toast(errMsg(err), 'error');
            }
          },
        },
      ],
    });
  };

  return (
    <div className="pbrowser">
      <div className="pbar">
        <div className="psearch">
          <Search size={15} />
          <input className="input" placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {toolbarExtra}
        <span className="spacer" />
        {archivedCount > 0 && (
          <button className={cls('chip', showArchived && 'active')} onClick={() => setShowArchived((v) => !v)} title="Projects you put away">
            <Archive size={13} /> Archived ({archivedCount})
          </button>
        )}
        <label className="psort" title="Sort by">
          <ArrowUpDown size={14} />
          <select className="select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <div className="pview" role="group" aria-label="View">
          <button className={cls('btn sm icon', view === 'grid' ? 'primary' : 'ghost')} onClick={() => setView('grid')} title="Cards">
            <LayoutGrid size={15} />
          </button>
          <button className={cls('btn sm icon', view === 'list' ? 'primary' : 'ghost')} onClick={() => setView('list')} title="List with details">
            <LayoutList size={15} />
          </button>
        </div>
      </div>

      {list.length === 0 ? (
        scoped.length === 0 && !showArchived ? (
          empty
        ) : (
          <div className="card">
            <div className="empty">
              <b>{showArchived ? 'Nothing matches in the archive' : 'No matching projects'}</b>
            </div>
          </div>
        )
      ) : view === 'grid' ? (
        <div className="project-grid">
          {list.map((p) => (
            <ProjectCard key={p.id} p={p} onMenu={openMenu} />
          ))}
        </div>
      ) : (
        <div className="card plist-wrap">
          <table className="plist">
            <thead>
              <tr>
                <th>Project</th>
                {showArea && <th className="hide-sm">Area</th>}
                <th>Version</th>
                <th className="hide-sm">Online</th>
                <th className="hide-md num">Chats</th>
                <th>Opened</th>
                <th className="hide-md">Created</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const a = areas.find((x) => x.id === p.area);
                return (
                  <tr key={p.id} className={cls(p.archived && 'archived')} onContextMenu={(e) => openMenu(e, p)}>
                    <td className="pname">
                      <Link to={`/p/${p.id}`} className="row" style={{ gap: 10 }}>
                        <span className="area-icon" style={{ ['--area' as string]: a?.color ?? '#94a3b8', width: 26, height: 26, borderRadius: 7, flex: 'none' }}>
                          <AreaIcon icon={a?.icon ?? 'sparkles'} size={13} />
                        </span>
                        <span className="col" style={{ gap: 0, minWidth: 0 }}>
                          <span className="row" style={{ gap: 6 }}>
                            <b className="ellipsis">{p.name}</b>
                            {p.pinned && <Pin size={12} color="var(--accent)" style={{ flex: 'none' }} />}
                            {p.busy && <span className="busy-pill">working</span>}
                          </span>
                          {p.description && <span className="faint small ellipsis">{p.description}</span>}
                        </span>
                      </Link>
                    </td>
                    {showArea && <td className="hide-sm muted small">{a?.name ?? p.area}</td>}
                    <td>
                      {p.version ? (
                        <span className="badge" title={p.releases ? `${p.releases} release${p.releases === 1 ? '' : 's'}` : 'no release yet'}>
                          <Tag size={11} /> {p.version}
                        </span>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td className="hide-sm">
                      <span className="row" style={{ gap: 6 }}>
                        {p.site && (
                          <span className="badge ok" title="Has a website">
                            <Globe size={11} /> site
                          </span>
                        )}
                        {!!p.servers && (
                          <span className="badge accent" title={`${p.servers} server${p.servers === 1 ? '' : 's'}`}>
                            <Server size={11} /> {p.servers}
                          </span>
                        )}
                        {!p.site && !p.servers && <span className="faint">—</span>}
                      </span>
                    </td>
                    <td className="hide-md num muted small">
                      {p.chats ? (
                        <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                          <MessageSquare size={12} /> {p.chats}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="muted small nowrap" title={new Date(p.lastOpenedAt ?? p.createdAt).toLocaleString()}>
                      {timeAgo(p.lastOpenedAt ?? p.createdAt)}
                    </td>
                    <td className="hide-md muted small nowrap">{new Date(p.createdAt).toLocaleDateString()}</td>
                    <td className="pact">
                      <button className="btn ghost icon sm" title={p.pinned ? 'Unpin' : 'Pin to the top'} onClick={() => void patch(p, { settings: { pinned: !p.pinned } })}>
                        {p.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                      </button>
                      <button className="btn ghost icon sm" title="More" onClick={(e) => openMenu(e, p)}>
                        <Ellipsis size={15} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="faint small" style={{ marginTop: 10 }}>
        {list.length} project{list.length === 1 ? '' : 's'}
        {showArchived ? ' in the archive' : ''}
        {q ? ` matching “${q}”` : ''}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
