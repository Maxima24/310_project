import type {
  AlertView,
  QueryAuditRequest,
  SystemMode,
  UpsertArmScheduleRequest,
} from '@cpe310/contracts';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import { useSessionStore } from '../stores/session.store';
import { ApiError, api } from './api';

/**
 * Query keys in one place, so the socket layer and the mutations cannot disagree with
 * the hooks about where a slice of state lives.
 *
 * Every key carries the session generation. A sign-in or sign-out bumps it, which makes
 * the previous identity's cached data unreachable by construction — no clearing, and
 * therefore no window in which a viewer briefly sees an admin's agents.
 */
export const qk = {
  me: (s: number) => ['me', s] as const,
  agents: (s: number) => ['agents', s] as const,
  events: (s: number) => ['events', s] as const,
  alerts: (s: number) => ['alerts', s] as const,
  mode: (s: number) => ['mode', s] as const,
  cameras: (s: number) => ['cameras', s] as const,
  notifications: (s: number, alertId: string) => ['notifications', s, alertId] as const,
  schedules: (s: number) => ['schedules', s] as const,
  audit: (s: number, query: QueryAuditRequest) => ['audit', s, query] as const,
  reports: (s: number, days: number) => ['reports', s, days] as const,
};

/** Retained event count, matching the hub's page size. */
const MAX_EVENTS = 60;
const MAX_ALERTS = 60;

/**
 * A 401/403 is a settled answer, not a transient failure — retrying it just produces
 * more rejected requests and delays showing the user what is wrong.
 */
function retryUnlessAuth(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && (error.isAuthFailure || error.isForbidden)) return false;
  return failureCount < 2;
}

/** The session generation every key is scoped to. */
function useSession(): number {
  return useSessionStore((s) => s.sessionId);
}

export function useIdentity() {
  const session = useSession();
  return useQuery({
    queryKey: qk.me(session),
    queryFn: api.me,
    retry: retryUnlessAuth,
    // Permissions change only when the hub's config does, so this need not be fresh per
    // render. It cannot leak across a sign-out either: the session-scoped key means the
    // next identity asks a different question.
    staleTime: 5 * 60_000,
  });
}

/**
 * `refetchInterval` is a parameter so a component that is genuinely waiting on a change
 * — the add-camera wizard watching for an agent to enrol — can ask for a faster poll
 * without a second query or a bespoke loop. TanStack uses the shortest interval among
 * live observers and reverts to this default when that component unmounts.
 */
export function useAgents(refetchInterval = 15_000) {
  const session = useSession();
  return useQuery({
    queryKey: qk.agents(session),
    queryFn: api.agents,
    retry: retryUnlessAuth,
    // secondsSinceLastSeen is computed by the hub per request, so it would freeze
    // between socket pushes. A slow poll keeps the "last seen" column honest without
    // making the WebSocket redundant.
    refetchInterval,
  });
}

export function useEvents() {
  const session = useSession();
  return useQuery({
    queryKey: qk.events(session),
    queryFn: () => api.events(MAX_EVENTS),
    retry: retryUnlessAuth,
  });
}

export function useAlerts() {
  const session = useSession();
  return useQuery({
    queryKey: qk.alerts(session),
    queryFn: () => api.alerts(MAX_ALERTS),
    retry: retryUnlessAuth,
  });
}

export function useMode() {
  const session = useSession();
  return useQuery({ queryKey: qk.mode(session), queryFn: api.mode, retry: retryUnlessAuth });
}

/**
 * Which cameras are live. Polled rather than pushed: a camera going quiet is the
 * absence of frames, which produces no event to broadcast.
 */
export function useCameras(enabled: boolean) {
  const session = useSession();
  return useQuery({
    queryKey: qk.cameras(session),
    queryFn: api.cameras,
    enabled,
    retry: retryUnlessAuth,
    refetchInterval: 10_000,
  });
}

/** Admin-only; `enabled` lets the caller skip it entirely rather than eat a 403. */
export function useNotifications(alertId: string | null, enabled: boolean) {
  const session = useSession();
  return useQuery({
    queryKey: qk.notifications(session, alertId ?? 'none'),
    queryFn: () => api.notificationsForAlert(alertId!),
    enabled: Boolean(alertId) && enabled,
    retry: retryUnlessAuth,
  });
}

/**
 * Arm state changes are NOT applied optimistically.
 *
 * The hub may refuse — disarming during an unacknowledged critical alert requires an
 * admin — and briefly showing the system as disarmed when it is not would be a
 * dangerous lie on a security panel. The broadcast `mode` event updates every client
 * from one source once the hub agrees.
 */
export function useSetMode() {
  const queryClient = useQueryClient();
  const session = useSession();

  return useMutation({
    mutationFn: (mode: SystemMode) => api.setMode(mode),
    onSuccess: (response) => {
      queryClient.setQueryData(qk.mode(session), {
        mode: response.mode,
        updatedAt: response.updatedAt,
      });
    },
  });
}

/**
 * Acknowledgement IS optimistic: it only ever dims a row, the hub broadcasts the real
 * state moments later, and a rollback on failure restores the exact previous list.
 */
export function useAcknowledge() {
  const queryClient = useQueryClient();
  const session = useSession();

  return useMutation({
    mutationFn: (alert: AlertView) => api.acknowledge(alert.id),

    onMutate: async (alert) => {
      await queryClient.cancelQueries({ queryKey: qk.alerts(session) });
      const previous = queryClient.getQueryData<AlertView[]>(qk.alerts(session));

      queryClient.setQueryData<AlertView[]>(qk.alerts(session), (current) =>
        (current ?? []).map((a) =>
          a.id === alert.id
            ? { ...a, acknowledged: true, acknowledgedAt: new Date().toISOString() }
            : a,
        ),
      );

      return { previous };
    },

    onError: (_error, _alert, context) => {
      if (context?.previous) queryClient.setQueryData(qk.alerts(session), context.previous);
    },

    onSuccess: (updated) => {
      upsertAlert(queryClient, session, updated);
    },
  });
}

/**
 * Acknowledges every alert in a cluster.
 *
 * Twenty repeats of one problem are one decision for the operator, so making them
 * twenty clicks would be the interface arguing with reality. Requests run sequentially
 * rather than in parallel: this is a burst of writes against a single hub, and a
 * thundering herd for a convenience feature is a poor trade.
 */
export function useAcknowledgeMany() {
  const queryClient = useQueryClient();
  const session = useSession();

  return useMutation({
    mutationFn: async (ids: string[]) => {
      const acknowledged: AlertView[] = [];
      for (const id of ids) {
        acknowledged.push(await api.acknowledge(id));
      }
      return acknowledged;
    },
    onSuccess: (updated) => {
      for (const alert of updated) upsertAlert(queryClient, session, alert);
    },
    // A partial failure leaves the cache disagreeing with the hub, so re-read rather
    // than guess which of the writes landed.
    onError: () => void queryClient.invalidateQueries({ queryKey: qk.alerts(session) }),
  });
}

/**
 * Merge one alert into the cached list.
 *
 * Shared by the mutation and the socket handler: an alert arrives again when it is
 * acknowledged, so it must REPLACE rather than prepend, or the list shows the same
 * alert twice with conflicting state.
 */
export function upsertAlert(
  queryClient: QueryClient,
  session: number,
  alert: AlertView,
): void {
  queryClient.setQueryData<AlertView[]>(qk.alerts(session), (current) => {
    const rest = (current ?? []).filter((a) => a.id !== alert.id);
    return [alert, ...rest].slice(0, MAX_ALERTS);
  });
}

export function useSchedules(enabled = true) {
  const session = useSession();
  return useQuery({
    queryKey: qk.schedules(session),
    queryFn: api.schedules,
    enabled,
    retry: retryUnlessAuth,
    // A schedule that fired changes lastFiredAt, and the evaluator ticks every 30s.
    refetchInterval: 60_000,
  });
}

export function useSaveSchedule() {
  const queryClient = useQueryClient();
  const session = useSession();

  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: UpsertArmScheduleRequest }) =>
      id ? api.updateSchedule(id, input) : api.createSchedule(input),
    // Refetched rather than merged: the hub re-seeds lastFiredFor when a boundary moves,
    // so the row that comes back is not simply the row that was sent.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.schedules(session) }),
  });
}

export function useDeleteSchedule() {
  const queryClient = useQueryClient();
  const session = useSession();

  return useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.schedules(session) }),
  });
}

/** Admin-only; `enabled` lets a non-admin skip the request rather than eat a 403. */
export function useAudit(query: QueryAuditRequest, enabled: boolean) {
  const session = useSession();
  return useQuery({
    queryKey: qk.audit(session, query),
    queryFn: () => api.audit(query),
    enabled,
    retry: retryUnlessAuth,
  });
}

export function useReports(days: number, enabled: boolean) {
  const session = useSession();
  return useQuery({
    queryKey: qk.reports(session, days),
    queryFn: () => api.reports(days),
    enabled,
    retry: retryUnlessAuth,
    // Aggregates over days; refetching them on every focus would be pure cost.
    staleTime: 5 * 60_000,
  });
}

export const CACHE_LIMITS = { MAX_EVENTS, MAX_ALERTS };
