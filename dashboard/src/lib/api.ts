import type {
  AgentView,
  AlertView,
  ArmScheduleView,
  AuditEntryView,
  AuthRole,
  BrowserCameraSessionResponse,
  CameraStatusView,
  CreateBrowserCameraRequest,
  EventView,
  IdentityResponse,
  NotificationView,
  QueryAuditRequest,
  ReportsSummary,
  StreamTicketResponse,
  SystemMode,
  SystemModeChangeResponse,
  SystemModeResponse,
  UpsertArmScheduleRequest,
} from '@cpe310/contracts';

import { OPERATOR_LABEL_HEADER } from '@cpe310/contracts';

import { currentCredential, currentLabel } from '../stores/session.store';
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

/**
 * The claimed operator name, if one was entered and it can legally travel in a header.
 *
 * Control characters are dropped here as well as on the hub: `fetch` throws outright on
 * a header containing a newline, which would turn a stray paste into an unexplained
 * failure of every request rather than a slightly odd name in the audit trail.
 */
function labelHeader(): Record<string, string> {
  const label = currentLabel()
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .trim();

  return label ? { [OPERATOR_LABEL_HEADER]: label } : {};
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${currentCredential()}`,
        ...labelHeader(),
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

  /** Admin-only. Returns the publishing token exactly once. */
  createBrowserCamera: (input: CreateBrowserCameraRequest) =>
    request<BrowserCameraSessionResponse>('/cameras/browser-sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  renewBrowserCamera: (agentId: string) =>
    request<BrowserCameraSessionResponse>(`/cameras/browser-sessions/${agentId}/renew`, {
      method: 'POST',
    }),

  revokeBrowserCamera: (agentId: string) =>
    request<void>(`/cameras/browser-sessions/${agentId}`, { method: 'DELETE' }),

  /**
   * Publishes one frame as a camera.
   *
   * Deliberately NOT routed through `request()`. That helper injects
   * `Authorization: Bearer ${currentCredential()}` and a JSON content type — both wrong
   * here, and the first is actively dangerous: sending the operator credential to a
   * publish endpoint would be handing a human credential to a route meant only for
   * scoped agent tokens. Taking the token as an explicit parameter makes that mistake
   * structurally impossible rather than merely unlikely.
   *
   * The Blob goes in as the body so fetch sets `Content-Type: image/jpeg` from
   * `blob.type`, which is what the hub's raw body parser matches on.
   */
  publishFrame: async (agentId: string, blob: Blob, token: string): Promise<void> => {
    const response = await fetch(`${API_BASE}/cameras/${agentId}/frame`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: blob,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) throw await toApiError(response);
  },

  /**
   * Best-effort revoke on tab close.
   *
   * `keepalive` lets the request outlive the page. Not `navigator.sendBeacon`, which
   * cannot set an Authorization header. A missed revoke is bounded rather than
   * permanent — the token expires on its own within the session TTL.
   */
  revokeBrowserCameraOnExit: (agentId: string): void => {
    void fetch(`${API_BASE}/cameras/browser-sessions/${agentId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${currentCredential()}` },
      keepalive: true,
    }).catch(() => {
      // Nothing useful to do from a page that is going away.
    });
  },

  schedules: () => request<ArmScheduleView[]>('/schedules'),

  createSchedule: (input: UpsertArmScheduleRequest) =>
    request<ArmScheduleView>('/schedules', { method: 'POST', body: JSON.stringify(input) }),

  updateSchedule: (id: string, input: UpsertArmScheduleRequest) =>
    request<ArmScheduleView>(`/schedules/${id}`, { method: 'PUT', body: JSON.stringify(input) }),

  deleteSchedule: (id: string) => request<void>(`/schedules/${id}`, { method: 'DELETE' }),

  /** Admin-only. */
  audit: (query: QueryAuditRequest = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const suffix = params.toString();
    return request<AuditEntryView[]>(`/audit${suffix ? `?${suffix}` : ''}`);
  },

  /**
   * Aggregated history. The browser's own zone is sent so day boundaries fall where the
   * operator expects rather than wherever the hub container happens to be.
   */
  reports: (days: number) =>
    request<ReportsSummary>(
      `/reports/summary?days=${days}&tz=${encodeURIComponent(
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      )}`,
    ),

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
