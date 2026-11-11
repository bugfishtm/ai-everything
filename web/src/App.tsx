import type { ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Empty, Spinner } from './components/ui';
import { AccountPage } from './pages/AccountPage';
import { AdminPage } from './pages/AdminPage';
import { AreaPage } from './pages/AreaPage';
import { ChatPage } from './pages/ChatPage';
import { Dashboard } from './pages/Dashboard';
import { LibraryPage } from './pages/LibraryPage';
import { LoginPage } from './pages/Login';
import { PacksPage } from './pages/PacksPage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { ServicesPage } from './pages/ServicesPage';
import { SkillsPage } from './pages/SkillsPage';
import { WebsitesPage } from './pages/WebsitesPage';
import { useStudio } from './store';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useStudio();
  const loc = useLocation();
  if (loading) {
    return (
      <div className="center" style={{ height: '100%' }}>
        <Spinner size={24} />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname + loc.search }} replace />;
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="page">
      <Empty title="Page not found">
        <Link to="/">Back home</Link>
      </Empty>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/p/:projectId"
        element={
          <RequireAuth>
            <ProjectPage />
          </RequireAuth>
        }
      />
      <Route
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="area/:areaId" element={<AreaPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="library" element={<LibraryPage key="mine" scope="mine" />} />
        <Route path="global" element={<LibraryPage key="global" scope="global" />} />
        <Route path="packs" element={<PacksPage />} />
        <Route path="servers" element={<ServicesPage />} />
        <Route path="websites" element={<WebsitesPage />} />
        <Route path="skills" element={<SkillsPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
