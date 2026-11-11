import { AppWindow, FolderOpen, Globe, GraduationCap, House, Library, LogOut, Menu, MessageCircle, Package, Server, Shield, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useStudio } from '../store';
import { AreaIcon } from './ui';

export function Brand() {
  const { meta } = useStudio();
  return (
    <NavLink to="/" className="brand">
      <span className="brand-mark">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <path d="M6 7h12M6 12h8M6 17h12" />
        </svg>
      </span>
      <span>
        {meta?.appName ?? 'Everything Studio'}
        <small>AI creative studio</small>
      </span>
    </NavLink>
  );
}

export function ClaudePill() {
  const { claude, limits } = useStudio();
  if (!claude) return null;
  const windows = (limits?.windows ?? []).filter((w) => w.percent !== null && (w.key === 'five_hour' || w.key === 'seven_day')).slice(0, 2);
  return (
    <NavLink to="/account#usage" className="col small" style={{ color: 'var(--text-dim)', gap: 6 }} title={claude.loggedIn ? `Connected (${claude.authMethod}) — open usage` : 'Connect your Claude account'}>
      <span className="row" style={{ gap: 8 }}>
        <span className={`status-dot ${claude.loggedIn ? 'ok' : 'bad'}`} />
        {claude.loggedIn ? `Claude connected${claude.plan ? ` · ${claude.plan}` : ''}` : 'Claude not connected'}
      </span>
      {windows.length > 0 && (
        <span className="limits-mini">
          {windows.map((w) => {
            const pct = Math.min(100, Math.max(0, w.percent ?? 0));
            return (
              <span key={w.key} title={`${w.label}: ${Math.round(pct)}% used${w.resetsAt ? `, resets ${new Date(w.resetsAt).toLocaleString()}` : w.resetsText ? `, resets ${w.resetsText}` : ''}`}>
                <span className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{w.key === 'five_hour' ? '5-hour limit' : 'Weekly limit'}</span>
                  <span>{Math.round(pct)}%</span>
                </span>
                <span className={`meter ${pct >= 95 ? 'bad' : pct >= 80 ? 'warn' : ''}`}>
                  <span style={{ width: `${pct}%` }} />
                </span>
              </span>
            );
          })}
        </span>
      )}
    </NavLink>
  );
}

/** Shown while the server downloads Claude Code (first start) or when it is missing. */
export function CliBanner() {
  const { cli, user } = useStudio();
  if (!cli || cli.state === 'ready') return null;
  const text =
    cli.state === 'installing'
      ? 'Claude Code is being downloaded on this server (first start) — Claude can work in a minute.'
      : cli.state === 'error'
        ? `Claude Code could not be installed: ${cli.error ?? 'unknown error'}`
        : 'Claude Code is not installed on this server yet.';
  return (
    <div className={`notice ${cli.state === 'error' ? 'error' : 'info'}`} style={{ margin: '12px 20px 0' }}>
      <div className="grow">
        {text} {user?.role === 'admin' && <NavLink to="/admin#claude-code">Admin → Claude Code</NavLink>}
      </div>
    </div>
  );
}

export function Shell() {
  const { user, areas, logout } = useStudio();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <Brand />
        <nav className="nav">
          <NavLink to="/" end>
            <House size={17} /> Home
          </NavLink>
          <NavLink to="/chat">
            <MessageCircle size={17} /> Chat
          </NavLink>
          <NavLink to="/projects">
            <FolderOpen size={17} /> Projects
          </NavLink>
          <NavLink to="/library">
            <Library size={17} /> My library
          </NavLink>
          <NavLink to="/global">
            <Globe size={17} /> Global Space
          </NavLink>
          <NavLink to="/packs">
            <Package size={17} /> Packs
          </NavLink>
          <NavLink to="/servers">
            <Server size={17} /> Servers
          </NavLink>
          <NavLink to="/websites">
            <AppWindow size={17} /> Websites
          </NavLink>
        </nav>
        <div className="nav-label">Create</div>
        <nav className="nav">
          {areas.map((a) => (
            <NavLink key={a.id} to={`/area/${a.id}`} style={{ ['--area' as string]: a.color }}>
              <span style={{ color: a.color, display: 'grid' }}>
                <AreaIcon icon={a.icon} size={16} />
              </span>
              {a.name}
              {a.projectCount > 0 && <span className="count">{a.projectCount}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="nav-label">You</div>
        <nav className="nav">
          <NavLink to="/skills">
            <GraduationCap size={17} /> Skills & instructions
          </NavLink>
          <NavLink to="/account">
            <UserRound size={17} /> Account & AI
          </NavLink>
          {user?.role === 'admin' && (
            <NavLink to="/admin">
              <Shield size={17} /> Admin
            </NavLink>
          )}
        </nav>
        <div className="sidebar-foot">
          <ClaudePill />
          <div className="userbox">
            <span className="avatar">{(user?.displayName || user?.username || '?').slice(0, 1).toUpperCase()}</span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis" style={{ fontWeight: 600 }}>
                {user?.displayName}
              </div>
              <div className="faint small ellipsis">@{user?.username}</div>
            </div>
            <button className="btn ghost icon sm" title="Log out" onClick={() => void logout()}>
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <main className="main">
        <div className="mobile-bar">
          <button className="btn ghost icon" onClick={() => setOpen(true)} aria-label="Menu">
            <Menu size={18} />
          </button>
          <b>Everything Studio</b>
        </div>
        <CliBanner />
        <Outlet />
      </main>
    </div>
  );
}
