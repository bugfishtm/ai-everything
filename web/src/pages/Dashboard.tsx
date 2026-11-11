import { ArrowRight, Globe, KeyRound, Library } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Project } from '../api';
import { ProjectCard } from '../components/ProjectBrowser';
import { AreaIcon } from '../components/ui';
import { useStudio } from '../store';

export { ProjectCard };

export function Dashboard() {
  const { user, areas, claude, agents } = useStudio();
  // the notice is about Claude only when Claude is the user's default AI
  const claudeIsDefault = (agents?.prefs.defaultProvider ?? 'claude') === 'claude';
  const [recent, setRecent] = useState<Project[] | null>(null);
  const [stats, setStats] = useState<{ mine: number; published: number; global: number } | null>(null);

  useEffect(() => {
    api<{ projects: Project[] }>('/projects')
      .then((r) => setRecent(r.projects.filter((x) => !x.archived).slice(0, 6)))
      .catch(() => setRecent([]));
    api<{ library: { mine: number; published: number; global: number } }>('/stats')
      .then((r) => setStats(r.library))
      .catch(() => {});
  }, []);

  return (
    <div className="page stack-lg">
      <section className="hero">
        <h1>Hi {user?.displayName?.split(' ')[0] ?? 'there'} — what do you want to create?</h1>
        <p>
          Pick an area, describe your idea, and Claude Code builds it in its own project folder: music, art, 3D models, videos, games and apps. Everything is stored as editable
          text, versioned, and reusable through your library.
        </p>
      </section>

      {claude && !claude.loggedIn && claudeIsDefault && (
        <div className="banner">
          <KeyRound size={20} color="var(--warn)" />
          <div className="grow">
            <b>Connect your Claude account</b>
            <div className="muted small">Claude Code runs with your own Claude subscription or API key. It takes a minute.</div>
          </div>
          <Link className="btn primary" to="/account">
            Connect <ArrowRight size={15} />
          </Link>
        </div>
      )}

      <section>
        <div className="section-title">
          <h2>Create</h2>
        </div>
        <div className="area-grid">
          {areas.map((a) => (
            <Link key={a.id} to={`/area/${a.id}`} className="area-card" style={{ ['--area' as string]: a.color }}>
              <span className="area-icon">
                <AreaIcon icon={a.icon} />
              </span>
              <h3>{a.name}</h3>
              <p>{a.tagline}</p>
              <div className="meta">
                {a.projectCount} project{a.projectCount === 1 ? '' : 's'}
                {a.tools.filter((t) => !['studio', 'browser'].includes(t.id)).length > 0 && ' · studio tools'}
              </div>
            </Link>
          ))}
        </div>
      </section>

      {recent && recent.length > 0 && (
        <section>
          <div className="section-title">
            <h2>Recent projects</h2>
            <span className="spacer" />
            <Link to="/projects" className="small">
              All projects →
            </Link>
          </div>
          <div className="project-grid">
            {recent.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
          </div>
        </section>
      )}

      <section className="project-grid">
        <Link to="/library" className="project-card">
          <div className="row">
            <Library size={18} color="var(--accent)" />
            <b>My library</b>
          </div>
          <p>Assets you and Claude saved for reuse — models, sprites, sounds, music…</p>
          <div className="faint small">
            {stats ? `${stats.mine} asset${stats.mine === 1 ? '' : 's'} · ${stats.published} published` : '…'}
          </div>
        </Link>
        <Link to="/global" className="project-card">
          <div className="row">
            <Globe size={18} color="var(--accent-2)" />
            <b>Global Space</b>
          </div>
          <p>Shared by everyone on this Studio. Claude searches it before creating something new.</p>
          <div className="faint small">{stats ? `${stats.global} shared asset${stats.global === 1 ? '' : 's'}` : '…'}</div>
        </Link>
      </section>
    </div>
  );
}
