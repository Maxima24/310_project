import { FRAME_TTL_MS, MAX_FRAME_BYTES } from '@cpe310/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

/** One camera's newest frame. */
interface StoredFrame {
  data: Buffer;
  receivedAt: number;
  width: number | null;
  height: number | null;
  /** Monotonic per camera, so two frames in the same millisecond are still distinct. */
  seq: number;
}

/**
 * A frame is stale after this. A camera that stopped should read as "no picture"
 * rather than showing a still from ten minutes ago, which is the worst possible
 * failure for a security display — it looks live.
 *
 * Both this and MAX_FRAME_BYTES now come from contracts, so a publisher can respect the
 * same limits the hub enforces. The dashboard in particular has to reason about the TTL
 * against its own poll interval: the two being equal is why a naive client blanked live
 * tiles for a whole cycle.
 *
 * Re-exported so the existing importers here keep working unchanged.
 */
export { FRAME_TTL_MS, MAX_FRAME_BYTES };

/** Tickets are exchanged immediately; seconds is plenty and limits the replay window. */
const TICKET_TTL_MS = 30_000;

/**
 * Concurrent viewers per camera. Each one holds a response open for as long as it
 * watches, so without a cap a reload loop — or a dashboard left open on a wall — can
 * pin an unbounded number of sockets against a hub that has real work to do.
 */
export const MAX_VIEWERS_PER_CAMERA = 4;

/** Window used to measure the ACHIEVED frame rate, as opposed to the configured one. */
const FPS_WINDOW_MS = 5_000;

interface Ticket {
  agentId: string;
  expiresAt: number;
}

/**
 * Holds the latest frame per camera, in memory only.
 *
 * Deliberately not Postgres and not S3. These frames are worthless a second after they
 * arrive — writing them anywhere durable would add IO proportional to frame rate and
 * grow forever, to store data nobody will ever read. Video *evidence* is the durable
 * path and already exists separately.
 *
 * Losing every frame on restart is therefore correct behaviour, not a limitation.
 */
@Injectable()
export class FrameStoreService {
  private readonly logger = new Logger(FrameStoreService.name);
  private readonly frames = new Map<string, StoredFrame>();
  private readonly tickets = new Map<string, Ticket>();
  /** Arrival timestamps inside FPS_WINDOW_MS, per camera, for the measured rate. */
  private readonly recent = new Map<string, number[]>();
  /** Open stream responses per camera, for the viewer cap. */
  private readonly viewers = new Map<string, number>();
  private sequence = 0;

  /**
   * Wakes waiting stream responses the instant a frame lands, so the MJPEG output runs
   * at the camera's real rate instead of a polling interval guessing at it.
   */
  private readonly arrivals = new EventEmitter();

  constructor() {
    // Node warns at 10 listeners; each viewer of each camera adds one.
    this.arrivals.setMaxListeners(0);
  }

  put(agentId: string, data: Buffer): void {
    const now = Date.now();
    const { width, height } = readJpegSize(data);

    this.sequence += 1;
    this.frames.set(agentId, { data, receivedAt: now, width, height, seq: this.sequence });

    // Keep only arrivals inside the measurement window; this is the achieved rate, which
    // is what makes "the feed is laggy" a number instead of an impression.
    const stamps = this.recent.get(agentId) ?? [];
    stamps.push(now);
    while (stamps.length > 0 && now - stamps[0] > FPS_WINDOW_MS) stamps.shift();
    this.recent.set(agentId, stamps);

    this.arrivals.emit(agentId);
  }

  /** Frames per second actually received over the recent window, or null when idle. */
  measuredFps(agentId: string): number | null {
    const stamps = this.recent.get(agentId);
    if (!stamps || stamps.length < 2) return null;

    const span = stamps[stamps.length - 1] - stamps[0];
    if (span <= 0) return null;
    return Math.round(((stamps.length - 1) / span) * 1000 * 10) / 10;
  }

  /**
   * Claims a viewer slot, or returns false when the camera is already at capacity.
   * The caller MUST call `releaseViewer` in a finally block, or slots leak on error.
   */
  claimViewer(agentId: string): boolean {
    const current = this.viewers.get(agentId) ?? 0;
    if (current >= MAX_VIEWERS_PER_CAMERA) return false;
    this.viewers.set(agentId, current + 1);
    return true;
  }

  releaseViewer(agentId: string): void {
    const current = this.viewers.get(agentId) ?? 0;
    if (current <= 1) this.viewers.delete(agentId);
    else this.viewers.set(agentId, current - 1);
  }

  viewerCount(agentId: string): number {
    return this.viewers.get(agentId) ?? 0;
  }

  /** Newest frame, or null when absent or stale. */
  get(agentId: string): StoredFrame | null {
    const frame = this.frames.get(agentId);
    if (!frame) return null;
    if (Date.now() - frame.receivedAt > FRAME_TTL_MS) return null;
    return frame;
  }

  /**
   * Waits for the next frame, or resolves null on timeout or abort.
   *
   * The abort signal matters more than it looks: without it a disconnecting viewer's
   * loop stays parked here for up to `timeoutMs`, so its slot against the viewer cap is
   * released that much later. Reload a tile four times quickly and you lock yourself
   * out of your own camera for five seconds.
   */
  next(agentId: string, timeoutMs: number, signal?: AbortSignal): Promise<StoredFrame | null> {
    return new Promise((resolve) => {
      const done = (value: StoredFrame | null) => {
        clearTimeout(timer);
        this.arrivals.off(agentId, onFrame);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };

      const onFrame = () => done(this.get(agentId));
      const onAbort = () => done(null);

      if (signal?.aborted) {
        resolve(null);
        return;
      }

      const timer = setTimeout(() => done(null), timeoutMs);
      this.arrivals.once(agentId, onFrame);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Which cameras are currently live, for the dashboard's camera list. */
  status(agentId: string): {
    streaming: boolean;
    frameAgeMs: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    viewers: number;
  } {
    const frame = this.get(agentId);
    if (!frame) {
      return {
        streaming: false,
        frameAgeMs: null,
        width: null,
        height: null,
        fps: null,
        viewers: this.viewerCount(agentId),
      };
    }
    return {
      streaming: true,
      frameAgeMs: Date.now() - frame.receivedAt,
      width: frame.width,
      height: frame.height,
      fps: this.measuredFps(agentId),
      viewers: this.viewerCount(agentId),
    };
  }

  /**
   * Mints a single-use ticket for one camera.
   *
   * An `<img>` cannot send an Authorization header, so without this the operator
   * credential would have to travel in the URL — into browser history, referrer
   * headers, and every proxy log along the way. A ticket is worth one stream of one
   * camera for a few seconds.
   */
  issueTicket(agentId: string): { ticket: string; expiresInMs: number } {
    this.sweepTickets();
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(ticket, { agentId, expiresAt: Date.now() + TICKET_TTL_MS });
    return { ticket, expiresInMs: TICKET_TTL_MS };
  }

  /**
   * Redeems a ticket for one camera. Consumed on use, so a leaked URL cannot be
   * replayed after the legitimate viewer has connected.
   */
  redeemTicket(ticket: string, agentId: string): boolean {
    const found = this.tickets.get(ticket);
    if (!found) return false;
    this.tickets.delete(ticket);
    if (found.expiresAt < Date.now()) return false;
    return found.agentId === agentId;
  }

  private sweepTickets(): void {
    const now = Date.now();
    for (const [key, value] of this.tickets) {
      if (value.expiresAt < now) this.tickets.delete(key);
    }
  }
}

/**
 * Reads dimensions straight from the JPEG's start-of-frame marker.
 *
 * Avoids pulling in an image library to answer a question the first few hundred bytes
 * already contain. Returns nulls rather than throwing on anything unexpected — the
 * dimensions are a nicety, and a camera should not fail to stream because its header
 * is unusual.
 */
function readJpegSize(data: Buffer): { width: number | null; height: number | null } {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return { width: null, height: null };

  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1];
    // SOF0..SOF15, excluding the non-frame markers DHT (c4), JPG (c8), DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    const segmentLength = data.readUInt16BE(offset + 2);
    if (segmentLength < 2) break;
    offset += 2 + segmentLength;
  }
  return { width: null, height: null };
}
