import type { AlertView, SystemMode } from '@cpe310/contracts';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import { ApiError, api } from './api';

/**
 * Query keys in one place, so the socket layer and the mutations cannot disagree with
 * the hooks about where a slice of state lives.
 */
export const qk = {
  me: ['me'] as const,
  agents: ['agents'] as const,
  events: ['events'] as const,
  alerts: ['alerts'] as const,
  mode: ['mode'] as const,
  notifications: (alertId: string) => ['notifications', alertId] as const,
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

export function useIdentity() {
  return useQuery({
    queryKey: qk.me,
    queryFn: api.me,
    retry: retryUnlessAuth,
    // Permissions change only when the hub's config does, so this need not be fresh
    // per render — but it must not be cached across a sign-out either, which the
    // credential-keyed cache reset in App handles.
    staleTime: 5 * 60_000,
  });
}

export function useAgents() {
  return useQuery({
    queryKey: qk.agents,
    queryFn: api.agents,
    retry: retryUnlessAuth,
    // secondsSinceLastSeen is computed by the hub per request, so it would freeze
    // between socket pushes. A slow poll keeps the "last seen" column honest without
    // making the WebSocket redundant.
    refetchInterval: 15_000,
  });
}

export function useEvents() {
  return useQuery({
    queryKey: qk.events,
    queryFn: () => api.events(MAX_EVENTS),
    retry: retryUnlessAuth,
  });
}

export function useAlerts() {
  return useQuery({ queryKey: qk.alerts, queryFn: () => api.alerts(MAX_ALERTS), retry: retryUnlessAuth });
}

export function useMode() {
  return useQuery({ queryKey: qk.mode, queryFn: api.mode, retry: retryUnlessAuth });
}

/** Admin-only; `enabled` lets the caller skip it entirely rather than eat a 403. */
export function useNotifications(alertId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: qk.notifications(alertId ?? 'none'),
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

  return useMutation({
    mutationFn: (mode: SystemMode) => api.setMode(mode),
    onSuccess: (response) => {
      queryClient.setQueryData(qk.mode, {
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

  return useMutation({
    mutationFn: (alert: AlertView) => api.acknowledge(alert.id),

    onMutate: async (alert) => {
      await queryClient.cancelQueries({ queryKey: qk.alerts });
      const previous = queryClient.getQueryData<AlertView[]>(qk.alerts);

      queryClient.setQueryData<AlertView[]>(qk.alerts, (current) =>
        (current ?? []).map((a) =>
          a.id === alert.id
            ? { ...a, acknowledged: true, acknowledgedAt: new Date().toISOString() }
            : a,
        ),
      );

      return { previous };
    },

    onError: (_error, _alert, context) => {
      if (context?.previous) queryClient.setQueryData(qk.alerts, context.previous);
    },

    onSuccess: (updated) => {
      upsertAlert(queryClient, updated);
    },
  });
}

/**
 * Merge one alert into the cached list.
 *
 * Shared by the mutation and the socket handler: an alert arrives again when it is
 * acknowledged, so it must REPLACE rather than prepend, or the list shows the same
 * alert twice with conflicting state.
 */
export function upsertAlert(queryClient: QueryClient, alert: AlertView): void {
  queryClient.setQueryData<AlertView[]>(qk.alerts, (current) => {
    const rest = (current ?? []).filter((a) => a.id !== alert.id);
    return [alert, ...rest].slice(0, MAX_ALERTS);
  });
}

export const CACHE_LIMITS = { MAX_EVENTS, MAX_ALERTS };
