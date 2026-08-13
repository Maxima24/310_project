import type {
  AgentView,
  AlertView,
  AuthRole,
  CameraStatusView,
  EventView,
  IdentityResponse,
  NotificationView,
  StreamTicketResponse,
  SystemMode,
  SystemModeChangeResponse,
  SystemModeResponse,
} from '@cpe310/contracts';

import { currentCredential } from '../stores/session.store';
import { API_BASE } from './config';

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

/**
 * A hub that accepts the connection but never answers would otherwise leave the UI on
 * a spinner indefinitely. Ten seconds is far longer than any of these endpoints needs,
 * so a timeout here means something is genuinely wrong and the user should be told.
 */
const REQUEST_TIMEOUT_MS = 10_000;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${currentCredential()}`,
        ...init.headers,
      },
    });
  } catch (error) {
    // Distinguish "took too long" from "could not connect": they need different fixes,
    // and "Failed to fetch" tells the user nothing.
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    throw new ApiError(
      0,
      timedOut
        ? `The hub did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`
        : 'Could not reach the hub. Is it running?',
    );
  }

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

  cameras: () => request<CameraStatusView[]>('/cameras'),

  /**
   * Exchanges the operator credential for a single-use stream ticket. Needed because
   * the `<img>` that consumes the stream cannot send an Authorization header.
   */
  streamTicket: (agentId: string) =>
    request<StreamTicketResponse>(`/cameras/${agentId}/ticket`, { method: 'POST' }),

  /**
   * Latest still as a blob, for the snapshot button.
   *
   * Goes through fetch rather than an `<img src>` so it carries the Authorization
   * header — no ticket needed, because unlike the stream this is one ordinary request.
   */
  snapshot: async (agentId: string): Promise<Blob> => {
    const response = await fetch(`${API_BASE}/cameras/${agentId}/snapshot`, {
      headers: { Authorization: `Bearer ${currentCredential()}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw await toApiError(response);
    return response.blob();
  },
};
