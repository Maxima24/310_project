"""Entry point: wires the platform to the logic and runs the loop.

Kept deliberately thin. Everything that involves a decision — what a pin reading means,
when to retry, what a payload looks like — lives in a module the test suite can import.
This file is the part that cannot be tested without a board, so there should be as little
of it as possible.

    Flash MicroPython, then copy this directory to the board:
        mpremote connect auto fs cp *.py :
    Copy config.example.py to config.py first and edit it.
"""

import time

import config
from contracts import AgentType, EventType, iso_timestamp
from hub_client import EventQueue, HubClient, next_backoff_ms
from sensor_logic import DoorContact, MotionDetector

import platform_esp32 as hw

VERSION = "esp32-1.0"


def log(message):
    print("[agent] %s" % message)


def main():
    wdt = hw.make_watchdog(timeout_ms=60_000)

    if hw.connect_wifi(config.WIFI_SSID, config.WIFI_PASSWORD, logger=log) is None:
        # Rebooting rather than idling: a board that cannot reach the network is useless,
        # and a reset costs a second and clears whatever transient state caused it.
        log("no network — resetting")
        time.sleep(5)
        import machine

        machine.reset()

    if not hw.sync_clock(logger=log):
        # Refusing to continue is deliberate. Without a real clock every event carries a
        # timestamp from the year 2000, the hub rejects each one as invalid ISO 8601, and
        # the failure reads as a payload bug rather than a clock problem.
        log("no NTP — resetting rather than sending events the hub will refuse")
        time.sleep(5)
        import machine

        machine.reset()

    client = HubClient(config.HUB_URL, hw.make_request_fn(logger=log), logger=log)

    capabilities = ["esp32"]
    if config.PIR_PIN is not None:
        capabilities.append("motion")
    if config.REED_PIN is not None:
        capabilities.append("door")

    # A door sensor if there is a reed switch, otherwise motion. The hub's type is about
    # what the agent primarily reports; both kinds of event are accepted from either.
    agent_type = AgentType.DOOR if config.REED_PIN is not None else AgentType.MOTION

    if not client.ensure_registered(
        config.AGENT_ID, agent_type, config.LOCATION, config.BOOTSTRAP_KEY, VERSION, capabilities
    ):
        log("could not enrol — resetting")
        time.sleep(10)
        import machine

        machine.reset()

    pir = hw.digital_in(config.PIR_PIN) if config.PIR_PIN is not None else None
    reed = hw.digital_in(config.REED_PIN, pull_up=True) if config.REED_PIN is not None else None

    motion = MotionDetector(cooldown_ms=config.MOTION_COOLDOWN_MS)
    door = DoorContact(inverted=config.REED_INVERTED)
    queue = EventQueue()

    camera_module = None
    if getattr(config, "CAMERA_ENABLED", False):
        camera_module = hw.init_camera(quality=config.CAMERA_QUALITY, logger=log)
        if camera_module is not None:
            client_cam = HubClient(config.HUB_URL, hw.make_request_fn(logger=log), logger=log)
            # A SEPARATE identity and token: the guard enforces that an agent token may act
            # only as its own agent, so one credential cannot publish both a door event and
            # a camera frame. That separation is the point, not an inconvenience.
            if not client_cam.ensure_registered(
                config.CAMERA_AGENT_ID, AgentType.CAMERA, config.CAMERA_LOCATION,
                config.BOOTSTRAP_KEY, VERSION, ["camera", "stream", "esp32"],
            ):
                log("camera could not enrol — continuing without it")
                camera_module = None

    started = time.time()
    last_beat = 0
    last_frame = 0
    failures = 0
    frame_interval = 1.0 / max(1, getattr(config, "CAMERA_FPS", 5))

    log("running as %s at %s" % (config.AGENT_ID, config.LOCATION))

    while True:
        hw.feed_watchdog(wdt)
        now_ms = hw.ticks_ms()
        warm = (time.time() - started) >= config.PIR_WARMUP_SECONDS

        if pir is not None and motion.update(bool(pir.value()), now_ms) and warm:
            queue.add((EventType.MOTION_DETECTED, hw.iso_now(), {"source": "pir"}))

        if reed is not None:
            transition = door.update(bool(reed.value()), now_ms)
            if transition:
                queue.add((transition, hw.iso_now(), {"source": "reed"}))

        # One event per pass, so a backlog drains steadily instead of blocking the loop
        # and leaving the sensors unread for seconds.
        pending = queue.peek()
        if pending:
            status = client.send_event(config.AGENT_ID, pending[0], pending[1], pending[2])
            if status in (200, 201):
                queue.pop()
                failures = 0
            else:
                failures += 1
                time.sleep_ms(next_backoff_ms(failures, _random))

        if time.time() - last_beat >= config.HEARTBEAT_SECONDS:
            client.heartbeat(config.AGENT_ID)
            last_beat = time.time()

        if camera_module is not None and (time.time() - last_frame) >= frame_interval:
            frame = hw.capture_jpeg(camera_module)
            if frame:
                client_cam.send_frame(config.CAMERA_AGENT_ID, frame)
            last_frame = time.time()
            frame = None  # Release before the next capture; two frames will not fit.

        time.sleep_ms(50)


def _random():
    import urandom

    return urandom.getrandbits(16) / 65535.0


if __name__ == "__main__":
    main()
