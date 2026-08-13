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
}

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
