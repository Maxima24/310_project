import type {
  AgentView,
  AlertView,
  AuthRole,
  EventView,
  IdentityResponse,
  NotificationView,
  SystemMode,
  SystemModeChangeResponse,
  SystemModeResponse,
} from '@cpe310/contracts';

import { currentCredential } from '../stores/session.store';

/**
 * Hub client.
 *
 * Every call carries the operator credential; the hub decides what it may do. The
 * dashboard never assumes — it asks (`/auth/me`) and gates the UI on the answer.
 */

/**
 * A refusal the hub explained. The policy layer returns human-readable reasons for
 * attribute-based denials (disarming during an incident, acting outside your zones), so
 * they are surfaced verbatim rather than replaced with a generic message.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Which role could perform the action instead, when the hub said. */
    readonly requiresRole?: AuthRole,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the credential is wrong, as opposed to merely insufficient. */
  get isAuthFailure(): boolean {
    return this.status === 401;
  }

  /** True when the credential is valid but not permitted to do this. */
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${currentCredential()}`,
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw await toApiError(response);
  }

  // 204 has no body; every other success path returns JSON.
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

async function toApiError(response: Response): Promise<ApiError> {
  let message = `Request failed (${response.status})`;
  let requiresRole: AuthRole | undefined;

  try {
    const body = (await response.json()) as {
      message?: string | { message?: string; requiresRole?: AuthRole };
      requiresRole?: AuthRole;
    };

    // Verified against the running hub: when a policy decision is thrown as an object
    // descriptor, Nest uses that object as the response body verbatim, so `message` and
    // `requiresRole` both sit at the top level:
    //   { "message": "1 critical alert still unacknowledged...", "requiresRole": "admin" }
    //
    // The nested branch is kept because Nest's own built-in exceptions (and the
    // ValidationPipe) put an object under `message` instead.
    if (typeof body.message === 'string') {
      message = body.message;
    } else if (body.message && typeof body.message === 'object') {
      message = body.message.message ?? message;
      requiresRole = body.message.requiresRole;
    }
    requiresRole = requiresRole ?? body.requiresRole;
  } catch {
    // Non-JSON error body; the status-derived message stands.
  }

  if (response.status === 401) {
    message = 'That credential was rejected by the hub.';
  }

  return new ApiError(response.status, message, requiresRole);
}

export const api = {
  /** Source of truth for what this credential may do. */
  me: () => request<IdentityResponse>('/auth/me'),

  agents: () => request<AgentView[]>('/agents'),
  events: (limit = 60) => request<EventView[]>(`/events?limit=${limit}`),
  alerts: (limit = 60) => request<AlertView[]>(`/alerts?limit=${limit}`),
  mode: () => request<SystemModeResponse>('/system/mode'),
  notificationsForAlert: (alertId: string) =>
    request<NotificationView[]>(`/notifications/alert/${alertId}`),

  setMode: (mode: SystemMode) =>
    request<SystemModeChangeResponse>('/system/mode', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),

  acknowledge: (id: string) => request<AlertView>(`/alerts/${id}/ack`, { method: 'POST' }),
};
