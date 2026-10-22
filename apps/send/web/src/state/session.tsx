import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { auth } from '@/api/client';
import { ApiError, setUnauthorizedHandler } from '@/api/http';
import type { Me, Team } from '@/api/types';

interface Session {
  me: Me;
  team: Team;
  teamId: string;
  setTeam: (id: string) => void;
  canManage: boolean;
  logout: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);
const KEY = 'send.team';

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

/** Current team id (shorthand for data hooks). */
export function useTeamId(): string {
  return useSession().teamId;
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => auth.me(),
    retry: (n, e) => !(e instanceof ApiError && (e.status === 401 || e.status === 403)) && n < 2,
    staleTime: 60_000,
  });
}

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const qc = useQueryClient();
  const [teamId, setTeamId] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved && me.teams.some((t) => t.id === saved)) return saved;
    } catch {
      /* storage blocked */
    }
    return me.teams[0]?.id ?? '';
  });
  useEffect(() => {
    if (!me.teams.some((t) => t.id === teamId) && me.teams[0]) setTeamId(me.teams[0].id);
  }, [me.teams, teamId]);
  const setTeam = useCallback(
    (id: string) => {
      setTeamId(id);
      try {
        localStorage.setItem(KEY, id);
      } catch {
        /* ignore */
      }
      qc.removeQueries({ predicate: (q) => q.queryKey[0] === 'team' });
    },
    [qc],
  );
  const logout = useCallback(async () => {
    try {
      await auth.logout();
    } finally {
      qc.clear();
      window.location.assign('/login');
    }
  }, [qc]);
  const team = me.teams.find((t) => t.id === teamId) ?? me.teams[0]!;
  const value = useMemo<Session>(
    () => ({ me, team, teamId: team.id, setTeam, canManage: team.role === 'admin' || team.role === 'superadmin', logout }),
    [me, team, setTeam, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUnauthorizedRedirect() {
  useEffect(() => {
    setUnauthorizedHandler(() => {
      const next = window.location.pathname + window.location.search;
      if (!window.location.pathname.startsWith('/login')) window.location.assign(`/login?next=${encodeURIComponent(next)}`);
    });
    return () => setUnauthorizedHandler(null);
  }, []);
}
