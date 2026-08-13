import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

/** One camera's newest frame. */
interface StoredFrame {
  data: Buffer;
  receivedAt: number;
  width: number | null;
  height: number | null;
}

/**
 * A frame is stale after this. A camera that stopped should read as "no picture"
 * rather than showing a still from ten minutes ago, which is the worst possible
 * failure for a security display — it looks live.
 */
const FRAME_TTL_MS = 10_000;

/** Tickets are exchanged immediately; seconds is plenty and limits the replay window. */
const TICKET_TTL_MS = 30_000;

/** Rejected above this. A 1080p JPEG is well under 1MB; more suggests a wrong content type. */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

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
    const { width, height } = readJpegSize(data);
    this.frames.set(agentId, { data, receivedAt: Date.now(), width, height });
    this.arrivals.emit(agentId);
  }

  /** Newest frame, or null when absent or stale. */
  get(agentId: string): StoredFrame | null {
    const frame = this.frames.get(agentId);
    if (!frame) return null;
    if (Date.now() - frame.receivedAt > FRAME_TTL_MS) return null;
    return frame;
  }

  /** Waits for the next frame, or resolves null if none arrives in time. */
  next(agentId: string, timeoutMs: number): Promise<StoredFrame | null> {
    return new Promise((resolve) => {
      const done = (value: StoredFrame | null) => {
        clearTimeout(timer);
        this.arrivals.off(agentId, onFrame);
        resolve(value);
      };
      const onFrame = () => done(this.get(agentId));
      const timer = setTimeout(() => done(null), timeoutMs);
      this.arrivals.once(agentId, onFrame);
    });
  }

  /** Which cameras are currently live, for the dashboard's camera list. */
  status(agentId: string): { streaming: boolean; frameAgeMs: number | null; width: number | null; height: number | null } {
    const frame = this.get(agentId);
    if (!frame) return { streaming: false, frameAgeMs: null, width: null, height: null };
    return {
      streaming: true,
      frameAgeMs: Date.now() - frame.receivedAt,
      width: frame.width,
      height: frame.height,
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
