/**
 * Live camera view.
 *
 * Deliberately separate from video evidence. Evidence is *durable* — clips written to
 * object storage and referenced from an event, kept for review. This is *ephemeral* —
 * the newest frame from each camera, held in the hub's memory only, never written to
 * Postgres or S3. Frames are worthless a second later and a database is the wrong place
 * for them.
 *
 * Transport is MJPEG: the agent posts JPEG frames, the hub keeps the latest per camera
 * and re-serves them. Not WebRTC, which would mean a media stack in the agent, signalling,
 * and NAT traversal for a picture that only ever travels across a LAN.
 */

import type { AgentOrigin } from './agent';

/** What `GET /cameras` reports: which cameras currently have a live frame. */
export interface CameraStatusView {
  agentId: string;
  location: string;
  /**
   * False when the camera is simulated, stopped, or was started without --stream.
   *
   * This — not an `<img>` error — is the authoritative liveness signal. A client that
   * reconnects on image errors alone will hammer a hub whose camera is simply switched
   * off; gating retries on this field means a stopped camera produces zero reconnect
   * traffic until it genuinely returns.
   */
  streaming: boolean;
  /** Age of the newest frame, or null when there is none. */
  frameAgeMs: number | null;
  width: number | null;
  height: number | null;
  /**
   * Frames per second the hub is ACTUALLY receiving, over a recent window — not the
   * rate the agent was configured with. The gap between the two is what makes "the
   * feed is laggy" a measurement instead of an impression.
   */
  fps: number | null;
  /** Open streams for this camera, against the hub's per-camera cap. */
  viewers: number;
  /** Where the frames come from. See AgentOrigin — this must be shown, not inferred. */
  origin: AgentOrigin;
}

/**
 * How long the hub holds a frame before calling the camera stopped.
 *
 * Lives here rather than only in the hub because the dashboard's polling interval has to
 * be reasoned about against it: the two being equal is why a naive client blanked live
 * tiles for a whole poll cycle.
 */
export const FRAME_TTL_MS = 10_000;

/**
 * Largest frame the hub will accept. A 1080p JPEG is well under 1MB; more suggests a
 * wrong content type. Shared so a publisher can drop an oversized frame itself instead of
 * discovering the limit as a 400 on every attempt.
 */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/**
 * Browsers allow roughly six concurrent connections per origin over HTTP/1.1, and an
 * MJPEG stream holds one for its entire life. Past this many open tiles, ordinary
 * requests — the agent list, alerts, even the ticket mints — queue behind the streams
 * and the whole dashboard appears to hang.
 *
 * HTTP/2 removes the limit, and Caddy negotiates it automatically on a real hostname,
 * but not on plain `:80` locally. So the client caps itself regardless.
 */
export const MAX_CONCURRENT_STREAMS = 4;

/**
 * A short-lived ticket for the MJPEG stream.
 *
 * The stream is consumed by an `<img>` tag, which cannot send an Authorization header —
 * so the credential would otherwise have to travel in the URL, where it lands in browser
 * history, referrer headers, and server logs. Instead the dashboard exchanges its real
 * credential for a single-use ticket that expires in seconds and grants exactly one
 * thing: watching one camera.
 */
export interface StreamTicketResponse {
  ticket: string;
  expiresInMs: number;
  /** Ready to use as an `<img>` src. */
  streamUrl: string;
}

/** Multipart boundary for the MJPEG response; shared so client and server agree. */
export const MJPEG_BOUNDARY = 'cpe310frame';

/* -------------------------------------------------------------- browser cameras
 *
 * A browser publishing its own webcam. Useful — it needs no install, works where Docker
 * cannot reach a USB device, and asks permission through the browser's own prompt, which
 * is the most consent-respecting flow available.
 *
 * It is also the one camera source an operator can fabricate, so the design spends its
 * effort on making such a feed IMPOSSIBLE TO MISTAKE for hardware rather than on
 * pretending it is equivalent. The honest limit: none of this stops an admin feeding
 * arbitrary video in. What it buys is that the feed is labelled at the source, cannot be
 * named to look like a device, is capped, and is recorded in the audit trail.
 */

/**
 * Reserved id prefix. The HUB generates these, never the client — that is what stops a
 * browser feed being named `camera-lobby` and passed off as the real lobby camera.
 * `POST /agents/register` refuses ids starting with it, so the namespace cannot be
 * squatted from the bootstrap path either.
 */
export const BROWSER_CAMERA_ID_PREFIX = 'browser-';

/** Concurrent browser cameras allowed. Bounds how much fabricated video can exist. */
export const MAX_BROWSER_CAMERAS = 4;

/**
 * How long a publishing token lasts. Short by design: the answer to "a laptop left
 * publishing in a meeting room forever" is that the session ends unless a human renews it.
 */
export const BROWSER_SESSION_TTL_MS = 30 * 60_000;

/**
 * Capture rate.
 *
 * The first version pinned this at 5 to match the Python agent's default, which was the
 * wrong reason: that default is conservative because a Pi encodes frames on a small CPU
 * and may be on Wi-Fi at the far end of a building. A browser on the same LAN as the hub
 * has neither constraint, and at 5fps the picture visibly steps rather than moves.
 *
 * 15 is the ceiling because each frame is a separate HTTP upload and the loop waits for
 * one to finish before starting the next — past this the limit stops being the setting
 * and starts being the round trip, which is a worse thing to be governed by.
 */
export const BROWSER_CAPTURE_FPS_CHOICES = [5, 10, 15] as const;
export const BROWSER_CAPTURE_DEFAULT_FPS = 10;
export const BROWSER_CAPTURE_MAX_FPS = 15;
export const BROWSER_CAPTURE_WIDTH = 640;
export const BROWSER_CAPTURE_HEIGHT = 480;
/** Slightly below the Python agent's, because these frames go up more often. */
export const BROWSER_CAPTURE_JPEG_QUALITY = 0.65;

/**
 * Client-side frame ceiling, far below MAX_FRAME_BYTES. A publisher that exceeds it drops
 * the frame and lowers quality rather than looping into a rejection.
 */
export const BROWSER_CAPTURE_MAX_FRAME_BYTES = 512 * 1024;

/**
 * `POST /cameras/browser-sessions` body.
 *
 * Note what is absent: no id, no type, no capabilities, no origin. The hub sets all four,
 * and the global ValidationPipe runs with `whitelist: true`, so any of them sent anyway is
 * stripped before it reaches a service.
 */
export interface CreateBrowserCameraRequest {
  location: string;
  /** Optional human note, e.g. "Ada's laptop". Displayed, never trusted. */
  label?: string;
}

/** Returned once. The hub keeps only a hash of the token. */
export interface BrowserCameraSessionResponse {
  agentId: string;
  token: string;
  expiresAt: string;
  maxFps: number;
  maxWidth: number;
}
