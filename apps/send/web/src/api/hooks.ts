import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useTeamId } from '@/state/session';
import { toastError } from '@/components/ui/toast';

/** Team-scoped query: key ['team', teamId, ...key]. Keeps previous data while paging/filtering. */
export function useTeamQuery<T>(key: QueryKey, fn: (teamId: string) => Promise<T>, opts: { enabled?: boolean; refetchInterval?: number | false; keepPrevious?: boolean } = {}) {
  const teamId = useTeamId();
  return useQuery({
    queryKey: ['team', teamId, ...key],
    queryFn: () => fn(teamId),
    enabled: opts.enabled ?? true,
    refetchInterval: opts.refetchInterval,
    placeholderData: opts.keepPrevious ? keepPreviousData : undefined,
  });
}

/**
 * Team-scoped mutation that invalidates the given key prefixes on success and
 * toasts errors (unless `silent`).
 */
export function useTeamMutation<V, R>(fn: (teamId: string, v: V) => Promise<R>, invalidate: QueryKey[] = [], opts: { silent?: boolean; onSuccess?: (r: R, v: V) => void } = {}) {
  const teamId = useTeamId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: V) => fn(teamId, v),
    onSuccess: async (r, v) => {
      await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: ['team', teamId, ...k] })));
      opts.onSuccess?.(r, v);
    },
    onError: (e) => {
      if (!opts.silent) toastError(e);
    },
  });
}
