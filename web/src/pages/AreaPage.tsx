import { GraduationCap, Plus, Sparkles, Wrench } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Project, type Skill } from '../api';
import { NewProjectModal } from '../components/Modals';
import { ProjectBrowser } from '../components/ProjectBrowser';
import { AreaIcon, Empty, Spinner } from '../components/ui';
import { useArea } from '../store';

export function AreaPage() {
  const { areaId } = useParams();
  const area = useArea(areaId);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [creating, setCreating] = useState<{ description?: string } | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);

  const load = useCallback(() => {
    if (!areaId) return;
    api<{ projects: Project[] }>(`/projects?area=${areaId}`)
      .then((r) => setProjects(r.projects))
      .catch(() => setProjects([]));
  }, [areaId]);
  useEffect(load, [load]);
  // the skills the AI can use in this area (active ones, each name once: own before added before built-in)
  useEffect(() => {
    if (!areaId) return;
    api<{ skills: Skill[] }>('/skills')
      .then((r) => {
        const rank = { mine: 0, global: 1, system: 2 } as const;
        const byName = new Map<string, Skill>();
        for (const s of r.skills) {
          if (!s.enabled || (s.areas.length && !s.areas.includes(areaId))) continue;
          const w = byName.get(s.slug);
          if (!w || rank[s.scope] < rank[w.scope]) byName.set(s.slug, s);
        }
        setSkills([...byName.values()].sort((a, b) => Number(a.areas.length === 0) - Number(b.areas.length === 0) || a.name.localeCompare(b.name)));
      })
      .catch(() => setSkills([]));
  }, [areaId]);

  if (!area) {
    return (
      <div className="page center">
        <Spinner />
      </div>
    );
  }
  const tools = area.tools;

  return (
    <div className="page stack-lg" style={{ ['--area' as string]: area.color }}>
      <div className="page-head">
        <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
          <span className="area-icon" style={{ width: 52, height: 52, borderRadius: 14 }}>
            <AreaIcon icon={area.icon} size={26} />
          </span>
          <div>
            <h1>{area.name}</h1>
            <p>{area.description}</p>
          </div>
        </div>
        <button className="btn primary lg" onClick={() => setCreating({})}>
          <Plus size={17} /> New project
        </button>
      </div>

      {area.starters.length > 0 && (
        <section>
          <div className="section-title">
            <Sparkles size={16} color="var(--accent)" />
            <h2>Start from an idea</h2>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            {area.starters.map((s) => (
              <button key={s} className="chip" onClick={() => setCreating({ description: s })}>
                {s}
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="section-title">
          <h2>Projects</h2>
        </div>
        {!projects ? (
          <Spinner />
        ) : (
          <ProjectBrowser
            projects={projects}
            onChange={(id, next) => setProjects((list) => (list ? (next ? list.map((x) => (x.id === id ? next : x)) : list.filter((x) => x.id !== id)) : list))}
            empty={
              <div className="card">
                <Empty icon={Plus} title={`No ${area.name.toLowerCase()} projects yet`}>
                  <button className="btn primary" style={{ marginTop: 8 }} onClick={() => setCreating({})}>
                    Create the first one
                  </button>
                </Empty>
              </div>
            }
          />
        )}
      </section>

      {skills.length > 0 && (
        <section>
          <div className="section-title">
            <GraduationCap size={16} color="var(--text-dim)" />
            <h2>Skills the AI brings here</h2>
            <Link to="/skills" className="small" style={{ marginLeft: 'auto' }}>
              Manage skills
            </Link>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            {skills.map((s) => (
              <Link key={s.key} to="/skills" className="chip" title={`${s.description}${s.auto ? '' : ' (only when you call it)'}`} style={{ textDecoration: 'none' }}>
                <span className="mono" style={{ color: 'var(--accent)' }}>/{s.slug}</span>
                <span className="faint">{s.name}</span>
              </Link>
            ))}
          </div>
          <div className="hint">Used automatically when a task matches — or start a message with the /name. Hover for what each one does.</div>
        </section>
      )}

      <section>
        <div className="section-title">
          <Wrench size={16} color="var(--text-dim)" />
          <h2>Tools Claude can use here</h2>
        </div>
        <div className="method-grid">
          {tools.map((t) => (
            <div key={t.id} className="tool-card">
              <b>{t.name}</b> <span className="faint small">{t.version ? `v${t.version}` : ''}</span>
              <p className="muted small" style={{ marginTop: 4 }}>
                {t.description}
              </p>
              {t.commands && t.commands.length > 0 && (
                <ul>
                  {t.commands.slice(0, 4).map((c) => (
                    <li key={c.usage}>
                      <code>{c.usage.split(' ').slice(0, 3).join(' ')}</code> — {c.description}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <div className="tool-card" style={{ borderStyle: 'dashed' }}>
            <b>More Studio software is coming</b>
            <p className="muted small" style={{ marginTop: 4 }}>
              Dedicated text-based tools for this area plug in automatically when they are added to the image (<code>tools/</code> folder). Until then Claude uses the
              toolchains in the image (Python, ffmpeg, ImageMagick, FluidSynth, Node.js, …).
            </p>
          </div>
        </div>
      </section>

      {creating && <NewProjectModal area={area} initialDescription={creating.description} onClose={() => setCreating(null)} />}
    </div>
  );
}
