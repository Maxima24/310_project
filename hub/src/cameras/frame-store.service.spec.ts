import { FrameStoreService, MAX_VIEWERS_PER_CAMERA } from './frame-store.service';

/** Smallest structurally valid JPEG: SOI, SOF0 with dimensions, EOI. */
function jpeg(width = 640, height = 480): Buffer {
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  const dims = Buffer.alloc(4);
  dims.writeUInt16BE(height, 0);
  dims.writeUInt16BE(width, 2);
  return Buffer.concat([header, dims, Buffer.from([0xff, 0xd9])]);
}

// Several suites here fake the clock. Restoring centrally rather than per-test means a
// suite that throws part-way cannot leak a mocked Date.now into the next one — which is
// exactly what made the disconnect test fail only when run with its neighbours.
afterEach(() => {
  jest.restoreAllMocks();
});

describe('FrameStoreService frames', () => {
  it('returns the newest frame and reads its dimensions from the JPEG header', () => {
    const store = new FrameStoreService();

    store.put('cam', jpeg(1280, 720));

    const frame = store.get('cam');
    expect(frame?.width).toBe(1280);
    expect(frame?.height).toBe(720);
  });

  it('gives every frame a distinct sequence number', () => {
    // The stream loop de-duplicates on this. It used to compare receivedAt, so two
    // frames arriving in the same millisecond silently dropped one.
    const store = new FrameStoreService();

    store.put('cam', jpeg());
    const first = store.get('cam')!.seq;
    store.put('cam', jpeg());
    const second = store.get('cam')!.seq;

    expect(second).toBeGreaterThan(first);
  });

  it('treats a frame older than the TTL as no frame at all', () => {
    // A stale still that looks live is the worst failure a security display can have.
    const store = new FrameStoreService();
    store.put('cam', jpeg());

    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    expect(store.get('cam')).toBeNull();
    expect(store.status('cam').streaming).toBe(false);

    jest.restoreAllMocks();
  });

  it('reports an unknown camera as not streaming rather than throwing', () => {
    expect(new FrameStoreService().status('nope').streaming).toBe(false);
  });
});

describe('FrameStoreService measured fps', () => {
  it('is null until there are two frames to measure between', () => {
    const store = new FrameStoreService();

    expect(store.measuredFps('cam')).toBeNull();
    store.put('cam', jpeg());
    expect(store.measuredFps('cam')).toBeNull();
  });

  it('measures the achieved rate, which is what makes "laggy" diagnosable', () => {
    const store = new FrameStoreService();
    const base = Date.now();
    const clock = jest.spyOn(Date, 'now');

    // Five frames, 200ms apart => 5fps.
    for (let i = 0; i < 5; i += 1) {
      clock.mockReturnValue(base + i * 200);
      store.put('cam', jpeg());
    }

    expect(store.measuredFps('cam')).toBeCloseTo(5, 1);
    clock.mockRestore();
  });
});

describe('FrameStoreService viewer cap', () => {
  it('admits viewers up to the cap and refuses the next', () => {
    // Each stream holds a response open for its whole life, so capacity is finite.
    const store = new FrameStoreService();

    for (let i = 0; i < MAX_VIEWERS_PER_CAMERA; i += 1) {
      expect(store.claimViewer('cam')).toBe(true);
    }

    expect(store.claimViewer('cam')).toBe(false);
    expect(store.viewerCount('cam')).toBe(MAX_VIEWERS_PER_CAMERA);
  });

  it('frees a slot on release, so a disconnect does not permanently consume capacity', () => {
    const store = new FrameStoreService();
    for (let i = 0; i < MAX_VIEWERS_PER_CAMERA; i += 1) store.claimViewer('cam');

    store.releaseViewer('cam');

    expect(store.claimViewer('cam')).toBe(true);
  });

  it('counts cameras independently', () => {
    const store = new FrameStoreService();
    for (let i = 0; i < MAX_VIEWERS_PER_CAMERA; i += 1) store.claimViewer('a');

    expect(store.claimViewer('b')).toBe(true);
  });

  it('does not go negative when released more often than claimed', () => {
    const store = new FrameStoreService();

    store.releaseViewer('cam');
    store.releaseViewer('cam');

    expect(store.viewerCount('cam')).toBe(0);
  });
});

describe('FrameStoreService.next', () => {
  it('resolves as soon as a frame arrives', async () => {
    const store = new FrameStoreService();
    const waiting = store.next('cam', 5_000);

    store.put('cam', jpeg());

    expect(await waiting).not.toBeNull();
  });

  it('resolves null on timeout', async () => {
    const store = new FrameStoreService();

    expect(await store.next('cam', 10)).toBeNull();
  });

  it('wakes immediately when the viewer disconnects', async () => {
    // Without this the loop stays parked for the full wait, so the viewer's slot is
    // released that much later — reload a tile a few times quickly and you lock
    // yourself out of your own camera.
    const store = new FrameStoreService();
    const controller = new AbortController();

    const started = Date.now();
    const waiting = store.next('cam', 5_000, controller.signal);
    controller.abort();

    expect(await waiting).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('returns immediately for an already-aborted signal', async () => {
    const store = new FrameStoreService();
    const controller = new AbortController();
    controller.abort();

    expect(await store.next('cam', 5_000, controller.signal)).toBeNull();
  });
});

describe('FrameStoreService tickets', () => {
  it('redeems a ticket exactly once', () => {
    // Single use is deliberate: a leaked URL must not become a permanent camera tap.
    const store = new FrameStoreService();
    const { ticket } = store.issueTicket('cam');

    expect(store.redeemTicket(ticket, 'cam')).toBe(true);
    expect(store.redeemTicket(ticket, 'cam')).toBe(false);
  });

  it('refuses a ticket minted for a different camera', () => {
    const store = new FrameStoreService();
    const { ticket } = store.issueTicket('cam-a');

    expect(store.redeemTicket(ticket, 'cam-b')).toBe(false);
  });

  it('refuses an expired ticket', () => {
    const store = new FrameStoreService();
    const { ticket, expiresInMs } = store.issueTicket('cam');

    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + expiresInMs + 1_000);
    expect(store.redeemTicket(ticket, 'cam')).toBe(false);
    jest.restoreAllMocks();
  });

  it('refuses an invented ticket', () => {
    expect(new FrameStoreService().redeemTicket('made-up', 'cam')).toBe(false);
  });
});
