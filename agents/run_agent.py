#!/usr/bin/env python3
"""CLI entrypoint for every collector agent.

    python run_agent.py --type motion --id motion-hallway --location "Hallway"
    python run_agent.py --type door   --id door-front     --location "Front door"
    python run_agent.py --type camera --id camera-lobby   --location "Lobby" --real --source 0

The API key comes from AGENT_API_KEY and must match the hub's:

    PowerShell:  $env:AGENT_API_KEY = "dev-key-change-me"
    bash/zsh:    export AGENT_API_KEY=dev-key-change-me
"""

from __future__ import annotations

import argparse
import logging
import os
import sys

from security_agent.agents import CameraAgent, DoorAgent, MotionAgent
from security_agent.base import BaseAgent
from security_agent.contracts import AgentType
from security_agent.sensors import (
    GpioDoorSensor,
    GpioMotionSensor,
    SimulatedDoorSensor,
    SimulatedMotionSensor,
)
from security_agent.transport import HttpTransport

DEFAULT_HUB = "http://localhost:3000"

EXIT_MISSING_KEY = 2
EXIT_BAD_HARDWARE = 3


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
    parser.add_argument("--interval", type=float, default=1.0, help="Seconds between sensor polls.")
    parser.add_argument(
        "--heartbeat-interval",
        type=float,
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
        type=float,
        default=None,
        help="Seconds to wait before reporting the same kind of activity again "
        "(default: 5 for motion, 10 for camera). Distinct from the hub's alert dedup.",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logging verbosity.",
    )
    return parser


def build_agent(args: argparse.Namespace, transport: HttpTransport) -> BaseAgent:
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

    return CameraAgent(
        args.id,
        args.location,
        transport,
        real=args.real,
        source=args.source,
        min_area=args.min_area,
        cooldown=args.cooldown if args.cooldown is not None else 10.0,
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

    api_key = os.environ.get("AGENT_API_KEY", "").strip()
    if not api_key:
        # Fail loudly here rather than letting the agent spin on 401s forever.
        print(
            "AGENT_API_KEY is not set — it must match the hub's key.\n"
            '  PowerShell:  $env:AGENT_API_KEY = "dev-key-change-me"\n'
            "  bash/zsh:    export AGENT_API_KEY=dev-key-change-me",
            file=sys.stderr,
        )
        return EXIT_MISSING_KEY

    transport = HttpTransport(args.hub, api_key)

    try:
        agent = build_agent(args, transport)
    except NotImplementedError as exc:
        # The gpiozero stubs land here — a clear pointer beats a traceback.
        print(f"{exc}", file=sys.stderr)
        transport.close()
        return EXIT_BAD_HARDWARE

    try:
        agent.run()
    except RuntimeError as exc:
        # Raised by the camera when OpenCV is missing or the source will not open.
        print(f"{exc}", file=sys.stderr)
        return EXIT_BAD_HARDWARE

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
