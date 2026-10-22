/** Admin console React glue: the AdminApi context and react-query hooks over it. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { JmapClient } from '../jmap/client';
import type { Id } from '../jmap/types';
import { CSRF_HEADERS, type Me } from '../api/auth';
import { useUi } from '../state/ui';
import { AdminApi, adminErrorMessage } from './api';
import type { Domain } from './types';
import { cloudflareApi } from './cloudflare';

interface AdminCtx {
  api: AdminApi;
  me: Me;
}

const Ctx = createContext<AdminCtx | null>(null);

export function useAdmin(): AdminCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAdmin outside AdminProvider');
  return c;
}

export function AdminProvider({ me, children, fallback }: { me: Me; children: ReactNode; fallback: ReactNode }) {
  const [ctx, setCtx] = useState<AdminCtx | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const client = new JmapClient({
      headers: CSRF_HEADERS,
      onUnauthorized: () => {
        if (!location.pathname.startsWith('/login')) location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      },
    });
    client
      .connect()
      .then(() => !cancelled && setCtx({ api: new AdminApi(client), me }))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [me]);
  if (error)
    return (
      <div className="boot-error">
        <p>The admin console couldn't connect to the mail server.</p>
        <p className="boot-error__detail">{error}</p>
        <button className="btn btn--filled" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    );
  if (!ctx) return <>{fallback}</>;
  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

// ------------------------------------------------------------------ queries
export const adminKeys = {
  all: ['admin'] as const,
  overview: ['admin', 'overview'] as const,
  domains: ['admin', 'domains'] as const,
  domain: (id: Id) => ['admin', 'domain', id] as const,
  domainStatus: (id: Id) => ['admin', 'domainStatus', id] as const,
  automation: ['admin', 'automation'] as const,
  accounts: (p: unknown) => ['admin', 'accounts', p] as const,
  account: (id: Id) => ['admin', 'account', id] as const,
  members: (id: Id) => ['admin', 'members', id] as const,
  lists: ['admin', 'lists'] as const,
  list: (id: Id) => ['admin', 'list', id] as const,
  cfZones: ['admin', 'cloudflare', 'zones'] as const,
  cfStatus: (domain: string) => ['admin', 'cloudflare', 'status', domain] as const,
};

/** Cloudflare zone names; `data === null` means Cloudflare isn't configured (hide the feature). */
export function useCloudflareZones() {
  return useQuery({ queryKey: adminKeys.cfZones, queryFn: () => cloudflareApi.zones(), staleTime: 60_000, retry: false });
}

/** Email Sending + record status for a domain, from the BFF. */
export function useCloudflareStatus(domain: string | undefined, opts: { enabled?: boolean; refetchInterval?: number | false } = {}) {
  return useQuery({
    queryKey: adminKeys.cfStatus(domain ?? ''),
    queryFn: () => cloudflareApi.status(domain!),
    enabled: !!domain && opts.enabled !== false,
    refetchInterval: opts.refetchInterval ?? 30_000,
    retry: false,
  });
}

export function useOverview() {
  const { api } = useAdmin();
  return useQuery({ queryKey: adminKeys.overview, queryFn: () => api.overview() });
}

export function useDomains() {
  const { api } = useAdmin();
  return useQuery({ queryKey: adminKeys.domains, queryFn: () => api.listDomains() });
}

export function useDomainMap(): Map<Id, Domain> {
  const { data } = useDomains();
  return useMemo(() => new Map((data ?? []).map((d) => [d.id, d])), [data]);
}

export function useDomain(id: Id) {
  const { api } = useAdmin();
  // The zone file fills in as DKIM keys are generated, so keep it fresh while open.
  return useQuery({ queryKey: adminKeys.domain(id), queryFn: () => api.getDomain(id), refetchInterval: 15_000 });
}

/** Status changes in the background (keys generated, records published), so poll while the page is open. */
export function useDomainStatus(id: Id) {
  const { api } = useAdmin();
  return useQuery({ queryKey: adminKeys.domainStatus(id), queryFn: () => api.domainStatus(id), refetchInterval: 15_000 });
}

export function useAutomation() {
  const { api } = useAdmin();
  return useQuery({ queryKey: adminKeys.automation, queryFn: () => api.automationOptions(), staleTime: 5 * 60_000 });
}

export interface AccountQuery {
  kind: 'User' | 'Group';
  domainId?: Id;
  search?: string;
  position: number;
  limit: number;
}

export function useAccounts(q: AccountQuery) {
  const { api } = useAdmin();
  const domainsById = useDomainMap();
  return useQuery({
    queryKey: adminKeys.accounts(q),
    queryFn: () => api.listAccounts({ ...q, domainsById }),
    placeholderData: keepPreviousData,
  });
}

export function useAccount(id: Id) {
  const { api } = useAdmin();
  return useQuery({ queryKey: adminKeys.account(id), queryFn: () => api.getAccount(id) });
}

export function useGroupMembers(id: Id) {
  const { api } = useAdmin();
  return useQuery({ queryKey: adminKeys.members(id), queryFn: () => api.groupMembers(id) });
}

export function useMailingLists() {
  const { api } = useAdmin();
  return useQuery({ queryKey: adminKeys.lists, queryFn: () => api.listMailingLists() });
}

export function useMailingList(id: Id) {
  const { api } = useAdmin();
  return useQuery({ queryKey: adminKeys.list(id), queryFn: () => api.getMailingList(id) });
}

/** Refetch every admin query (after a mutation done outside useAdminAction). */
export function useRefreshAdmin() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: adminKeys.all }), [qc]);
}

/**
 * Run a mutation: shows a snackbar on success or failure and refreshes every
 * admin query. Resolves to whether it succeeded.
 */
export function useAdminAction() {
  const qc = useQueryClient();
  const showSnack = useUi((s) => s.showSnack);
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn: () => Promise<unknown>, success?: string): Promise<boolean> => {
      setBusy(true);
      try {
        await fn();
        if (success) showSnack({ text: success });
        return true;
      } catch (e) {
        showSnack({ text: adminErrorMessage(e), duration: 0 });
        return false;
      } finally {
        setBusy(false);
        await qc.invalidateQueries({ queryKey: adminKeys.all });
      }
    },
    [qc, showSnack],
  );
  return { run, busy };
}
