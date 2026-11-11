import { FolderOpen } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Project } from '../api';
import { ProjectBrowser } from '../components/ProjectBrowser';
import { Empty, Spinner } from '../components/ui';
import { useStudio } from '../store';

export function ProjectsPage() {
  const { areas } = useStudio();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [area, setArea] = useState('');

  useEffect(() => {
    api<{ projects: Project[] }>('/projects')
      .then((r) => setProjects(r.projects))
      .catch(() => setProjects([]));
  }, []);

  const inArea = useCallback((p: Project) => !area || p.area === area, [area]);
  const used = new Set((projects ?? []).map((p) => p.area));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p>Every project is a folder with its own history, versions, chats and files. Pin the ones you work on, archive the ones that are done.</p>
        </div>
      </div>
      {!projects ? (
        <Spinner />
      ) : (
        <ProjectBrowser
          projects={projects}
          showArea
          filter={inArea}
          onChange={(id, next) => setProjects((list) => (list ? (next ? list.map((x) => (x.id === id ? next : x)) : list.filter((x) => x.id !== id)) : list))}
          toolbarExtra={
            <>
              <button className={`chip ${!area ? 'active' : ''}`} onClick={() => setArea('')}>
                All
              </button>
              {areas
                .filter((a) => used.has(a.id))
                .map((a) => (
                  <button key={a.id} className={`chip ${area === a.id ? 'active' : ''}`} onClick={() => setArea(a.id)}>
                    <span className="dot" style={{ background: a.color }} /> {a.name}
                  </button>
                ))}
            </>
          }
          empty={
            <div className="card">
              <Empty icon={FolderOpen} title={projects.length ? 'No projects in this area' : 'No projects yet'}>
                {!projects.length && (
                  <>
                    Pick an area on the <Link to="/">home page</Link> to start.
                  </>
                )}
              </Empty>
            </div>
          }
        />
      )}
    </div>
  );
}
