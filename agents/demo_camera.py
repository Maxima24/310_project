"""Synthetic camera: pushes generated JPEG frames to the hub as a real camera agent.

Exists because the simulated camera agent deliberately produces no frames — there is
nothing to look at, so `_maybe_stream` is only reached from the real-hardware path. That
leaves the whole live-view stack (multipart stream, viewer cap, fps measurement,
auto-reconnect) untestable without switching on somebody's webcam.

This fills that gap with a moving bar and a running clock, so a stalled feed is obvious
at a glance rather than looking like a picture of a static room. It enrolls through the
normal bootstrap flow and publishes with its own issued token, so it exercises exactly
the authorisation path a real camera does.

Uses cv2 only to DRAW and ENCODE — it never opens a capture device, so no camera is
switched on. Frames are real JPEGs rather than another format relabelled: the hub reads
width and height from the start-of-frame marker, and a PNG sent as `image/jpeg` would
stream but report null dimensions.

    python agents/demo_camera.py                    # 5 fps, 640x480
    python agents/demo_camera.py --fps 2 --width 320 --height 240
    python agents/demo_camera.py --id camera-b      # a second feed, to test the cap

Ctrl+C to stop. Stopping is itself a test: the tile should re-send the last frame, then
close cleanly, then recover unaided when this restarts.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
import urllib.error
import urllib.request
from typing import Any

DEFAULT_HUB = os.environ.get("HUB_URL", "http://localhost:3000")


def load_bootstrap_key() -> str:
    """Reads AGENT_BOOTSTRAP_KEY from the repo .env, so this cannot drift from the hub."""
    if key := os.environ.get("AGENT_BOOTSTRAP_KEY"):
        return key

    here = os.path.dirname(os.path.abspath(__file__))
    for candidate in (
        os.path.join(here, "..", ".env"),
        os.path.join(here, "..", "hub", ".env"),
    ):
        if not os.path.exists(candidate):
            continue
        with open(candidate, encoding="utf-8") as handle:
            for line in handle:
                name, _, value = line.strip().partition("=")
                if name == "AGENT_BOOTSTRAP_KEY" and value:
                    return value

    sys.exit("No AGENT_BOOTSTRAP_KEY found in the environment, .env, or hub/.env")


def post(url: str, body: bytes, content_type: str, token: str) -> tuple[int, bytes]:
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": content_type, "Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    except OSError as error:
        # Hub restarting, or not up yet. Reported by the caller's failure counter.
        return 0, str(error).encode()


def render(np: Any, cv2: Any, width: int, height: int, index: int, started: float) -> Any:
    """A dark ground, a faint grid, a sweeping bar, and a running clock."""
    frame = np.full((height, width, 3), (34, 24, 18), dtype=np.uint8)

    # The grid makes a frozen frame distinguishable from a genuinely static scene.
    step = max(20, width // 16)
    frame[::step, :] = (51, 39, 30)
    frame[:, ::step] = (51, 39, 30)

    # The moving element. Its position is a pure function of the frame index, so a
    # stalled stream shows a stationary bar rather than a plausible-looking picture.
    bar_w = max(12, width // 26)
    bar_x = int((index * max(3, width // 90)) % max(1, width - bar_w))
    frame[height // 4 : (height * 3) // 4, bar_x : bar_x + bar_w] = (247, 128, 47)

    elapsed = time.time() - started
    clock = f"{int(elapsed // 60):02d}:{elapsed % 60:04.1f}"
    scale = max(0.5, width / 900)

    cv2.putText(frame, clock, (12, int(34 * scale) + 6), cv2.FONT_HERSHEY_SIMPLEX,
                scale, (248, 244, 240), max(1, int(scale * 2)), cv2.LINE_AA)
    cv2.putText(frame, f"synthetic  frame {index}", (12, height - 14),
                cv2.FONT_HERSHEY_SIMPLEX, scale * 0.5, (150, 161, 147),
                max(1, int(scale)), cv2.LINE_AA)

    return frame


def main() -> int:
    parser = argparse.ArgumentParser(description="Synthetic camera feed for testing.")
    parser.add_argument("--hub", default=DEFAULT_HUB)
    parser.add_argument("--id", default="camera-demo")
    parser.add_argument("--location", default="Lobby")
    parser.add_argument("--fps", type=float, default=5.0)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--quality", type=int, default=70)
    args = parser.parse_args()

    # Imported here rather than at module scope for the same reason the real camera agent
    # defers cv2: a top-level import would make this file unimportable — and break the
    # test suite — anywhere the hardware extras are not installed.
    try:
        import cv2
        import numpy as np
    except ImportError as error:
        print(f"This needs numpy and opencv ({error}).", file=sys.stderr)
        print("  pip install -r agents/requirements-hardware.txt", file=sys.stderr)
        return 1

    bootstrap = load_bootstrap_key()

    payload = json.dumps({
        "id": args.id,
        "type": "camera",
        "location": args.location,
        "version": "synthetic",
        "capabilities": ["camera", "stream", "synthetic"],
    }).encode()

    status, body = post(f"{args.hub}/agents/register", payload, "application/json", bootstrap)
    if status != 200:
        print(f"Enrollment failed ({status}): {body.decode(errors='replace')[:300]}")
        return 1

    token = json.loads(body)["enrollment"]["token"]
    print(
        f"Enrolled {args.id} at {args.location} — publishing {args.fps:g}fps "
        f"{args.width}x{args.height} to {args.hub}"
    )
    print("Dashboard -> Cameras -> Watch live.  Ctrl+C to stop.")

    running = True

    def stop(*_: Any) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    encode_params = [cv2.IMWRITE_JPEG_QUALITY, max(10, min(95, args.quality))]
    interval = 1.0 / args.fps if args.fps > 0 else 0.2
    started = time.time()
    index = 0
    last_beat = 0.0
    failures = 0

    while running:
        cycle = time.time()
        frame = render(np, cv2, args.width, args.height, index, started)
        ok, buffer = cv2.imencode(".jpg", frame, encode_params)

        if ok:
            status, body = post(
                f"{args.hub}/cameras/{args.id}/frame", buffer.tobytes(), "image/jpeg", token
            )
            if status in (200, 201):
                if failures:
                    print(f"recovered after {failures} failed push(es)")
                failures = 0
            else:
                failures += 1
                # Once, then every 50th: a hub restart should not fill the terminal with
                # the same line while the retry loop quietly does its job.
                if failures == 1 or failures % 50 == 0:
                    print(f"push failed ({status}): {body.decode(errors='replace')[:160]}")

        # Heartbeats keep this out of the liveness sweep, which would otherwise mark it
        # offline mid-test and raise an agent_offline alert of its own making.
        if cycle - last_beat > 10:
            post(f"{args.hub}/agents/{args.id}/heartbeat", b"{}", "application/json", token)
            last_beat = cycle

        index += 1
        time.sleep(max(0.0, interval - (time.time() - cycle)))

    print(f"\nStopped after {index} frames. The dashboard tile will show 'No signal' shortly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
