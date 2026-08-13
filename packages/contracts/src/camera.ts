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
  /** False when the camera is simulated, stopped, or was started without --stream. */
  streaming: boolean;
  /** Age of the newest frame, or null when there is none. */
  frameAgeMs: number | null;
  width: number | null;
  height: number | null;
}

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
