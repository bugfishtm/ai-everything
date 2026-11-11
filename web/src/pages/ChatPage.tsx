import { useEffect, useState } from 'react';
import { api, errMsg, type Area, type Project } from '../api';
import { ChatPanel } from '../components/ChatPanel';
import { Empty, Spinner, useUi } from '../components/ui';

const MODELS: [string, string][] = [
  ['', 'Claude: default model'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku (fast)'],
];

/**
 * Casual conversations with Claude (or another AI) — no project needed. The chats live in a
 * hidden per-user project (attachments in its assets/uploads folder).
 */
export function ChatPage() {
  const ui = useUi();
  const [home, setHome] = useState<{ project: Project; area: Area } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ project: Project; area: Area }>('/chat/home')
      .then(setHome)
      .catch((err) => setError(errMsg(err)));
  }, []);

  const setModel = async (model: string) => {
    if (!home) return;
    const r = await api<{ project: Project }>(`/projects/${home.project.id}`, { method: 'PATCH', body: { settings: { model } } });
    setHome((h) => (h ? { ...h, project: { ...h.project, settings: r.project.settings } } : h));
  };

  if (error) {
    return (
      <div className="page">
        <Empty title="Chat is not available">{error}</Empty>
      </div>
    );
  }
  if (!home) {
    return (
      <div className="center" style={{ height: '100%' }}>
        <Spinner />
      </div>
    );
  }
  return (
    <div className="chat-page">
      <ChatPanel
        project={home.project}
        area={home.area}
        variant="casual"
        onOpenHistory={() => {}}
        headerExtra={
          <select
            className="select"
            style={{ height: 30, width: 'auto' }}
            value={home.project.settings.model ?? ''}
            title="Claude model used on the Chat page (other AIs use your default model from the Account page)"
            onChange={(e) => void setModel(e.target.value).catch((err) => ui.toast(errMsg(err), 'error'))}
          >
            {MODELS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        }
      />
    </div>
  );
}
