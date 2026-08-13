import type {
  AgentView,
  AlertView,
  EventView,
  NotificationView,
  SystemMode,
  SystemModeResponse,
} from '@cpe310/contracts';

/**
 * Hub client.
 *
 * Everything here needs the OPERATOR credential — agent tokens are deliberately
 * refused on these routes, so a compromised sensor cannot read the building's history
 * or disarm the system.
 */

/** Where the operator key is held. sessionStorage, not localStorage — see App.tsx. */
const KEY_STORAGE = 'cpe310.operatorKey';

export function getOperatorKey(): string {
  return sessionStorage.getItem(KEY_STORAGE) ?? '';
}

export function setOperatorKey(key: string): void {
  sessionStorage.setItem(KEY_STORAGE, key);
}

export function clearOperatorKey(): void {
  sessionStorage.removeItem(KEY_STORAGE);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getOperatorKey()}`,
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ApiError(
      response.status,
      response.status === 401 || response.status === 403
        ? 'The operator key was rejected.'
        : `${response.status}: ${body.slice(0, 200)}`,
    );
  }

  return (await response.json()) as T;
}

export const api = {
  agents: () => request<AgentView[]>('/agents'),
  events: (limit = 40) => request<EventView[]>(`/events?limit=${limit}`),
  alerts: (limit = 40) => request<AlertView[]>(`/alerts?limit=${limit}`),
  mode: () => request<SystemModeResponse>('/system/mode'),
  notifications: (alertId: string) =>
    request<NotificationView[]>(`/notifications/alert/${alertId}`),

  setMode: (mode: SystemMode) =>
    request<SystemModeResponse>('/system/mode', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),

  acknowledge: (id: string) => request<AlertView>(`/alerts/${id}/ack`, { method: 'POST' }),
};
