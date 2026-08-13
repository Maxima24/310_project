#!/usr/bin/env python3
"""CLI entrypoint for every collector agent.

    python run_agent.py --type motion --id motion-hallway --location "Hallway"
    python run_agent.py --type door   --id door-front     --location "Front door"
    python run_agent.py --type camera --id camera-lobby   --location "Lobby" --real --source 0

Credentials (roadmap item 2): an agent enrolls once with the hub's bootstrap key and
is issued its own token, which it then uses for everything else. The token is cached
under ~/.cpe310 so a restart does not rotate it.

    PowerShell:  $env:AGENT_BOOTSTRAP_KEY = "dev-bootstrap-key-change-me"
    bash/zsh:    export AGENT_BOOTSTRAP_KEY=dev-bootstrap-key-change-me

The bootstrap key cannot arm/disarm, acknowledge alerts, or read history — that
needs the operator credential, which agents never see.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from security_agent.agents import CameraAgent, DoorAgent, MotionAgent
from security_agent.base import AgentConfigurationError, BaseAgent
from security_agent.contracts import AgentType
from security_agent.credentials import TokenStore
from security_agent.evidence import ClipUploader, EvidenceRecorder
from security_agent.sensors import (
    GpioDoorSensor,
    GpioMotionSensor,
    SimulatedDoorSensor,
    SimulatedMotionSensor,
)
from security_agent.transport import HttpTransport, MqttTransport, Transport, TransportError

DEFAULT_HUB = "http://localhost:3000"

EXIT_MISSING_KEY = 2
EXIT_BAD_HARDWARE = 3
EXIT_BAD_ARGS = 4


def positive_float(raw: str) -> float:
    """argparse type for intervals.

    Zero or negative would turn the poll loop into a busy-wait pinning a core, and
    a negative heartbeat interval would beat continuously — both look like the agent
    "just hangs", so reject them at parse time with a readable message.
    """
    try:
        value = float(raw)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{raw!r} is not a number") from None
    if value <= 0:
        raise argparse.ArgumentTypeError(f"must be greater than 0 (got {value})")
    return value


def non_negative_float(raw: str) -> float:
    """argparse type for cooldowns, where 0 legitimately means 'no cooldown'."""
    try:
        value = float(raw)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{raw!r} is not a number") from None
    if value < 0:
        raise argparse.ArgumentTypeError(f"cannot be negative (got {value})")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="run_agent.py",
        description="Run one collector agent against the security hub.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Simulation mode is the default and needs no hardware or OpenCV.\n"
            "Set AGENT_API_KEY to the hub's key before starting."
        ),
    )
    parser.add_argument(
        "--type",
        required=True,
        choices=[str(t) for t in AgentType],
        help="Which kind of sensor this agent drives.",
    )
    parser.add_argument(
        "--id",
        required=True,
        help="Stable agent id, e.g. motion-hallway. Becomes the hub's primary key, "
        "so reusing it across restarts preserves the agent's history.",
    )
    parser.add_argument("--location", default="Unknown", help='Human-readable place, e.g. "Hallway".')
    parser.add_argument(
        "--hub",
        default=os.environ.get("HUB_URL", DEFAULT_HUB),
        help=f"Hub base URL (env HUB_URL, default {DEFAULT_HUB}).",
    )
    parser.add_argument(
        "--interval", type=positive_float, default=1.0, help="Seconds between sensor polls."
    )
    parser.add_argument(
        "--heartbeat-interval",
        type=positive_float,
        default=10.0,
        help="Seconds between heartbeats. Must stay below the hub's HEARTBEAT_TIMEOUT_MS.",
    )
    parser.add_argument(
        "--real",
        action="store_true",
        help="Use real hardware instead of simulation (GPIO for motion/door, OpenCV for camera).",
    )

    hardware = parser.add_argument_group("hardware options (with --real)")
    hardware.add_argument("--pin", type=int, default=4, help="BCM GPIO pin for a motion/door sensor.")
    hardware.add_argument(
        "--source",
        default="0",
        help="Camera source: a device index (0) or a stream URL (rtsp://...).",
    )
    hardware.add_argument(
        "--min-area",
        type=float,
        default=1500.0,
        help="Camera: minimum contour area in pixels to count as motion.",
    )

    parser.add_argument(
        "--cooldown",
        type=non_negative_float,
        default=None,
        help="Seconds to wait before reporting the same kind of activity again "
        "(default: 5 for motion, 10 for camera). Distinct from the hub's alert dedup.",
    )
    evidence = parser.add_argument_group("video evidence (camera, roadmap item 5)")
    evidence.add_argument(
        "--record-evidence",
        action="store_true",
        help="Record a short clip around each detection. Needs --real and opencv; "
        "uploads to S3/MinIO when --s3-endpoint is set, otherwise keeps clips locally.",
    )
    evidence.add_argument(
        "--clip-dir",
        default=os.environ.get("CLIP_DIR", "clips"),
        help="Where clips are written before upload (default ./clips).",
    )
    evidence.add_argument(
        "--pre-roll",
        type=non_negative_float,
        default=2.0,
        help="Seconds of footage kept from BEFORE the detection (default 2). Motion is "
        "only detected once a subject is well into frame, so this is what captures the entry.",
    )
    evidence.add_argument(
        "--post-roll",
        type=positive_float,
        default=3.0,
        help="Seconds recorded after the detection (default 3).",
    )
    evidence.add_argument(
        "--keep-local-clips",
        action="store_true",
        help="Keep the local copy after a successful upload. Off by default: a Pi's SD "
        "card fills within days otherwise.",
    )
    evidence.add_argument(
        "--s3-endpoint",
        default=os.environ.get("S3_ENDPOINT"),
        help="S3/MinIO endpoint, e.g. http://localhost:9000 (env S3_ENDPOINT).",
    )
    evidence.add_argument(
        "--s3-bucket", default=os.environ.get("S3_BUCKET", "evidence"), help="Bucket name."
    )
    evidence.add_argument(
        "--s3-public-url",
        default=os.environ.get("S3_PUBLIC_URL"),
        help="Base URL to embed in event metadata, when it differs from the endpoint "
        "the agent uploads through (e.g. a container name vs a browser-reachable host).",
    )

    net = parser.add_argument_group("transport (roadmap item 4)")
    net.add_argument(
        "--transport",
        choices=["http", "mqtt"],
        default=os.environ.get("AGENT_TRANSPORT", "http"),
        help="How to reach the hub. HTTP is the default; mqtt uses a broker, which "
        "scales better past ~20 agents and on flaky networks. Enrollment always uses "
        "HTTP either way, since it is a request/response exchange returning a secret.",
    )
    net.add_argument(
        "--mqtt-host",
        default=os.environ.get("MQTT_HOST", "localhost"),
        help="MQTT broker host (env MQTT_HOST).",
    )
    net.add_argument(
        "--mqtt-port",
        type=int,
        default=int(os.environ.get("MQTT_PORT", "1883")),
        help="MQTT broker port (env MQTT_PORT, default 1883).",
    )

    creds = parser.add_argument_group("credentials")
    creds.add_argument(
        "--token-dir",
        default=os.environ.get("AGENT_TOKEN_DIR"),
        help="Where to cache this agent's issued token (default ~/.cpe310). "
        "Caching avoids a token rotation on every restart.",
    )
    creds.add_argument(
        "--no-token-cache",
        action="store_true",
        help="Do not persist the token. The agent re-enrolls (and rotates) on every "
        "start — useful for ephemeral containers, noisier in the hub's audit log.",
    )

    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logging verbosity.",
    )
    return parser


def build_evidence(
    args: argparse.Namespace,
) -> tuple[ClipUploader | None, EvidenceRecorder | None]:
    """Wires up clip recording, and an uploader only if a store was configured.

    Recording without an uploader is deliberately supported: clips land on disk, which
    is enough for a single-camera setup with no object store.
    """
    if not args.record_evidence:
        return None, None

    if not args.real:
        # Simulated frames do not exist, so there is nothing to record. Say so rather
        # than silently producing no clips.
        print(
            "--record-evidence needs --real (there are no frames to record in "
            "simulation mode); continuing without evidence capture.",
            file=sys.stderr,
        )
        return None, None

    uploader = None
    if args.s3_endpoint:
        uploader = ClipUploader(
            endpoint=args.s3_endpoint,
            bucket=args.s3_bucket,
            access_key=os.environ.get("S3_ACCESS_KEY", "minioadmin"),
            secret_key=os.environ.get("S3_SECRET_KEY", "minioadmin"),
            public_base_url=args.s3_public_url,
        )
    else:
        print(
            "No --s3-endpoint set; clips will be kept locally in "
            f"{args.clip_dir} and not uploaded.",
            file=sys.stderr,
        )

    recorder = EvidenceRecorder(
        args.id,
        uploader=uploader,
        output_dir=Path(args.clip_dir),
        pre_roll_seconds=args.pre_roll,
        post_roll_seconds=args.post_roll,
        # A camera polls every 0.2s by default, so ~5fps of captured frames. Matching
        # the writer's fps to the real capture rate keeps playback speed honest.
        fps=max(1.0, 1.0 / (args.interval if args.interval != 1.0 else 0.2)),
        keep_local=args.keep_local_clips or uploader is None,
    )
    return uploader, recorder


def build_agent(args: argparse.Namespace, transport: Transport) -> BaseAgent:
    agent_type = AgentType(args.type)

    if agent_type is AgentType.MOTION:
        sensor = GpioMotionSensor(args.pin) if args.real else SimulatedMotionSensor()
        return MotionAgent(
            args.id,
            args.location,
            transport,
            sensor,
            poll_interval=args.interval,
            heartbeat_interval=args.heartbeat_interval,
            cooldown=args.cooldown if args.cooldown is not None else 5.0,
        )

    if agent_type is AgentType.DOOR:
        sensor = GpioDoorSensor(args.pin) if args.real else SimulatedDoorSensor()
        return DoorAgent(
            args.id,
            args.location,
            transport,
            sensor,
            poll_interval=args.interval,
            heartbeat_interval=args.heartbeat_interval,
        )

    uploader, recorder = build_evidence(args)

    return CameraAgent(
        args.id,
        args.location,
        transport,
        real=args.real,
        source=args.source,
        min_area=args.min_area,
        cooldown=args.cooldown if args.cooldown is not None else 10.0,
        recorder=recorder,
        uploader=uploader,
        # A camera polls faster than a PIR: frames are the unit of work, and the
        # cooldown (not the poll rate) is what limits reporting.
        poll_interval=args.interval if args.interval != 1.0 else 0.2,
        heartbeat_interval=args.heartbeat_interval,
    )


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)-7s %(name)-28s %(message)s",
    )

    bootstrap_key = os.environ.get("AGENT_BOOTSTRAP_KEY", "").strip()
    if not bootstrap_key:
        # Fail loudly here rather than letting the agent spin on 401s forever.
        print(
            "AGENT_BOOTSTRAP_KEY is not set — it must match the hub's AGENT_BOOTSTRAP_KEY.\n"
            '  PowerShell:  $env:AGENT_BOOTSTRAP_KEY = "dev-bootstrap-key-change-me"\n'
            "  bash/zsh:    export AGENT_BOOTSTRAP_KEY=dev-bootstrap-key-change-me\n"
            "\n"
            "Note: this is the enrollment secret only. The agent exchanges it for its\n"
            "own token on first run and caches that under ~/.cpe310.",
            file=sys.stderr,
        )
        return EXIT_MISSING_KEY

    token_store = (
        None
        if args.no_token_cache
        else TokenStore(args.id, Path(args.token_dir) if args.token_dir else None)
    )

    # BaseAgent only ever touches the Transport interface, so this is the entire cost
    # of switching transports — the agent logic above it is untouched.
    transport: Transport
    if args.transport == "mqtt":
        try:
            transport = MqttTransport(
                args.mqtt_host,
                args.mqtt_port,
                args.hub,
                bootstrap_key,
                token_store=token_store,
                agent_id=args.id,
            )
        except TransportError as exc:
            # Missing paho-mqtt lands here; a traceback would obscure the one-line fix.
            print(f"{exc}", file=sys.stderr)
            return EXIT_BAD_ARGS
    else:
        transport = HttpTransport(args.hub, bootstrap_key, token_store=token_store)

    if args.heartbeat_interval >= 30.0:
        # The hub's default HEARTBEAT_TIMEOUT_MS is 30s, so beating this slowly gets
        # the agent swept offline between beats and produces phantom tamper alerts.
        print(
            f"Warning: --heartbeat-interval {args.heartbeat_interval}s is at or above the "
            "hub's default 30s timeout; the hub will report this agent as offline "
            "between beats. Raise HEARTBEAT_TIMEOUT_MS on the hub to match.",
            file=sys.stderr,
        )

    try:
        agent = build_agent(args, transport)
    except NotImplementedError as exc:
        # The gpiozero stubs land here — a clear pointer beats a traceback.
        print(f"{exc}", file=sys.stderr)
        transport.close()
        return EXIT_BAD_HARDWARE

    try:
        agent.run()
    except AgentConfigurationError as exc:
        # Missing OpenCV, an unopenable source, or a stream that died for good.
        print(f"{exc}", file=sys.stderr)
        return EXIT_BAD_HARDWARE
    except KeyboardInterrupt:
        # Ctrl-C during registration backoff lands here, before the signal handler
        # is doing the work. A traceback would make a clean stop look like a crash.
        return 0

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
