import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type AgentsData, type Area, type ClaudeStatus, type CliStatus, type Meta, type PlanLimits, type User } from './api';
import { socket } from './ws';

interface StudioState {
  meta: Meta | null;
  user: User | null;
  loading: boolean;
  areas: Area[];
  claude: ClaudeStatus | null;
  /** Claude plan limits (5-hour / weekly windows) — null until known */
  limits: PlanLimits | null;
  refreshLimits: (force?: boolean) => Promise<void>;
  /** Claude Code CLI on the server (downloaded at runtime) */
  cli: CliStatus | null;
  refreshCli: () => Promise<void>;
  /** other AI providers switched on here (+ this user's keys and preferences) */
  agents: AgentsData | null;
  refreshAgents: () => Promise<void>;
  setUser: (u: User | null) => void;
  refreshUser: () => Promise<void>;
  refreshAreas: () => Promise<void>;
  refreshClaude: (force?: boolean) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<StudioState | null>(null);

export function StudioProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [areas, setAreas] = useState<Area[]>([]);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [limits, setLimits] = useState<PlanLimits | null>(null);
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [agents, setAgents] = useState<AgentsData | null>(null);

  const refreshUser = useCallback(async () => {
    try {
      const r = await api<{ user: User }>('/auth/me');
      setUser(r.user);
    } catch {
      setUser(null);
    }
  }, []);

  const refreshAreas = useCallback(async () => {
    try {
      setAreas((await api<{ areas: Area[] }>('/areas')).areas);
    } catch {
      /* not logged in */
    }
  }, []);

  const refreshClaude = useCallback(async (force = false) => {
    try {
      setClaude((await api<{ status: ClaudeStatus }>(`/claude/status${force ? '?refresh=1' : ''}`)).status);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshLimits = useCallback(async (force = false) => {
    try {
      setLimits((await api<{ limits: PlanLimits }>(`/usage/limits${force ? '?refresh=1' : ''}`)).limits);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshCli = useCallback(async () => {
    try {
      setCli((await api<{ cli: CliStatus }>('/claude/cli')).cli);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshAgents = useCallback(async () => {
    try {
      setAgents(await api<AgentsData>('/agents'));
    } catch {
      /* ignore */
    }
  }, []);

  const logout = useCallback(async () => {
    await api('/auth/logout', { body: {} }).catch(() => {});
    socket.stop();
    setUser(null);
    setClaude(null);
    setLimits(null);
    setAgents(null);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setMeta(await api<Meta>('/meta'));
      } catch {
        /* server down */
      }
      await refreshUser();
      setLoading(false);
    })();
    const onUnauthorized = () => setUser(null);
    window.addEventListener('studio:unauthorized', onUnauthorized);
    return () => window.removeEventListener('studio:unauthorized', onUnauthorized);
  }, [refreshUser]);

  useEffect(() => {
    if (!user) return;
    socket.start();
    void refreshAreas();
    void refreshClaude();
    void refreshLimits();
    void refreshCli();
    void refreshAgents();
    let agentsTimer: ReturnType<typeof setTimeout> | undefined;
    const offAgents = socket.on((msg) => {
      if (msg.t === 'agents.changed') {
        clearTimeout(agentsTimer);
        agentsTimer = setTimeout(() => void refreshAgents(), 400);
      }
    });
    const offMain = socket.on((msg) => {
      if (msg.t === 'claude.cli') {
        void refreshCli();
        void refreshClaude(true);
      }
      if (msg.t === 'claude.changed') {
        void refreshClaude(true);
        void refreshLimits(true);
      }
      // a run reported new rate-limit numbers (stream-json rate_limit_event)
      if (msg.t === 'usage.limits' && msg.limits) setLimits((cur) => (cur?.source === 'claude-code-usage' && msg.limits.windows.length === 0 ? cur : msg.limits));
    });
    return () => {
      offMain();
      offAgents();
      clearTimeout(agentsTimer);
    };
  }, [user, refreshAreas, refreshClaude, refreshLimits, refreshCli, refreshAgents]);

  return (
    <Ctx.Provider
      value={{ meta, user, loading, areas, claude, limits, refreshLimits, cli, refreshCli, agents, refreshAgents, setUser, refreshUser, refreshAreas, refreshClaude, logout }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useStudio(): StudioState {
  const v = useContext(Ctx);
  if (!v) throw new Error('StudioProvider missing');
  return v;
}

/** Display name of an AI: "Claude" or the agent's name (OpenAI Codex, Google Gemini, OpenCode …). */
export function useProviderName(): (id: string | undefined | null) => string {
  const { agents } = useStudio();
  return (id) => (!id || id === 'claude' ? 'Claude' : (agents?.agents.find((a) => a.id === id)?.name ?? id));
}

export function useArea(id: string | undefined): Area | undefined {
  return useStudio().areas.find((a) => a.id === id);
}
