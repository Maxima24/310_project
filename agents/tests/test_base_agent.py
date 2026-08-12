"""Agent event construction and edge detection.

These assert against literal wire strings on purpose: they are the drift detector
for the hand-mirrored contracts in ``security_agent/contracts.py``. If the hub's
TypeScript enums change and this file is not updated, these fail rather than the
fleet silently 400-ing in the field.
"""

from __future__ import annotations

import pytest

from security_agent.agents import CameraAgent, DoorAgent, MotionAgent
from security_agent.contracts import AgentDescriptor, AgentType, EventType, SensorEvent
from security_agent.sensors import SimulatedDoorSensor
from security_agent.transport import Transport


class FakeSensor:
    """Replays a fixed sequence of readings, then repeats the last one."""

    def __init__(self, readings: list[bool]) -> None:
        self._readings = list(readings)
        self._index = 0
        self.closed = False

    def read(self) -> bool:
        value = self._readings[min(self._index, len(self._readings) - 1)]
        self._index += 1
        return value

    def close(self) -> None:
        self.closed = True


class RecordingTransport(Transport):
    def __init__(self) -> None:
        self.registered: list[AgentDescriptor] = []
        self.heartbeats: list[str] = []
        self.events: list[SensorEvent] = []
        self.closed = False

    def register(self, descriptor: AgentDescriptor) -> None:
        self.registered.append(descriptor)

    def heartbeat(self, agent_id: str) -> None:
        self.heartbeats.append(agent_id)

    def publish_event(self, event: SensorEvent) -> None:
        self.events.append(event)

    def close(self) -> None:
        self.closed = True


# -- wire format -------------------------------------------------------------


def test_event_payload_uses_the_hubs_camelcase_keys() -> None:
    event = SensorEvent(agent_id="motion-hallway", type=EventType.MOTION_DETECTED, metadata={"source": "pir"})

    payload = event.to_payload()

    assert set(payload) == {"agentId", "type", "occurredAt", "metadata"}
    assert payload["agentId"] == "motion-hallway"
    assert payload["type"] == "motion_detected"
    assert payload["metadata"] == {"source": "pir"}


def test_occurred_at_is_millisecond_utc_with_a_trailing_z() -> None:
    # The hub validates with @IsISO8601({strict: true}); microseconds and a
    # +00:00 offset are what Python emits by default and are harder to read.
    stamp = SensorEvent(agent_id="a", type=EventType.DOOR_OPENED).occurred_at

    assert stamp.endswith("Z")
    assert "+00:00" not in stamp
    assert len(stamp.split(".")[-1]) == 4  # "123Z"


def test_descriptor_omits_absent_optional_fields() -> None:
    # The hub's DTO marks version/capabilities @IsOptional; an explicit null fails
    # @IsString, so they must be absent rather than None.
    payload = AgentDescriptor(id="door-front", type=AgentType.DOOR, location="Front door").to_payload()

    assert payload == {"id": "door-front", "type": "door", "location": "Front door"}


# -- motion ------------------------------------------------------------------


def test_motion_agent_reports_a_single_event_on_activity() -> None:
    agent = MotionAgent(
        "motion-hallway", "Hallway", RecordingTransport(), FakeSensor([True]), poll_interval=1.0, cooldown=0.0
    )

    events = agent.poll()

    assert len(events) == 1
    assert events[0].type == EventType.MOTION_DETECTED
    assert events[0].agent_id == "motion-hallway"


def test_motion_agent_stays_quiet_when_the_sensor_is_idle() -> None:
    agent = MotionAgent("m", "Hallway", RecordingTransport(), FakeSensor([False]), cooldown=0.0)

    assert agent.poll() == []


def test_motion_agent_cooldown_suppresses_a_chattering_sensor() -> None:
    # 5s cooldown at a 1s poll interval => report, then four silent polls.
    agent = MotionAgent(
        "m", "Hallway", RecordingTransport(), FakeSensor([True]), poll_interval=1.0, cooldown=5.0
    )

    reported = [len(agent.poll()) for _ in range(7)]

    assert reported == [1, 0, 0, 0, 0, 1, 0]


# -- door --------------------------------------------------------------------


def test_door_agent_reports_edges_not_levels() -> None:
    # A door held open for three polls is one event, not three.
    sensor = FakeSensor([False, True, True, True, False])
    agent = DoorAgent("door-front", "Front door", RecordingTransport(), sensor)

    types = [e.type for _ in range(5) for e in agent.poll()]

    assert types == [EventType.DOOR_OPENED, EventType.DOOR_CLOSED]


def test_door_agent_is_silent_on_a_first_reading_of_closed() -> None:
    # Otherwise every agent start would emit a meaningless door_closed.
    agent = DoorAgent("d", "Front door", RecordingTransport(), FakeSensor([False]))

    assert agent.poll() == []


def test_door_agent_reports_a_door_found_already_open_at_startup() -> None:
    agent = DoorAgent("d", "Front door", RecordingTransport(), FakeSensor([True]))

    events = agent.poll()

    assert [e.type for e in events] == [EventType.DOOR_OPENED]
    assert events[0].metadata["initial"] is True


def test_simulated_door_holds_open_for_several_polls() -> None:
    # Independent coin flips would produce open/closed chatter no real door makes.
    sensor = SimulatedDoorSensor(open_probability=1.0, hold_polls=3, seed=1)

    assert [sensor.read() for _ in range(4)] == [True, True, True, True]


# -- camera ------------------------------------------------------------------


def test_camera_agent_constructs_without_opencv_installed() -> None:
    # cv2 is imported lazily; simulation mode must work on a Python with no wheel.
    agent = CameraAgent("camera-lobby", "Lobby", RecordingTransport(), real=False, seed=7)

    assert agent.agent_type == AgentType.CAMERA
    assert "simulated" in agent.capabilities


def test_camera_simulation_emits_camera_motion_with_contour_metadata() -> None:
    agent = CameraAgent(
        "camera-lobby",
        "Lobby",
        RecordingTransport(),
        real=False,
        simulated_probability=1.0,
        cooldown=0.0,
        seed=7,
    )

    events = agent.poll()

    assert [e.type for e in events] == [EventType.CAMERA_MOTION]
    # A dashboard reading contour_area must work against simulated agents too.
    assert events[0].metadata["contour_area"] > 0
    assert events[0].metadata["source"] == "simulated"


def test_camera_cooldown_collapses_one_person_walking_past() -> None:
    agent = CameraAgent(
        "c", "Lobby", RecordingTransport(), real=False, simulated_probability=1.0, cooldown=60.0, seed=7
    )

    total = sum(len(agent.poll()) for _ in range(10))

    assert total == 1


def test_camera_real_mode_explains_how_to_fix_a_missing_opencv() -> None:
    agent = CameraAgent("c", "Lobby", RecordingTransport(), real=True, source=0)

    try:
        import cv2  # noqa: F401, PLC0415
    except ImportError:
        with pytest.raises(RuntimeError, match="requirements-hardware"):
            agent.poll()
    else:
        pytest.skip("OpenCV is installed here, so the missing-wheel path cannot be exercised")


# -- lifecycle ---------------------------------------------------------------


def test_descriptor_carries_type_location_and_capabilities_to_the_hub() -> None:
    agent = MotionAgent("motion-hallway", "Hallway", RecordingTransport(), FakeSensor([False]))

    descriptor = agent.descriptor()

    assert descriptor.type == AgentType.MOTION
    assert descriptor.location == "Hallway"
    assert "motion" in descriptor.capabilities


def test_shutdown_closes_the_sensor_and_the_transport() -> None:
    transport = RecordingTransport()
    sensor = FakeSensor([False])
    agent = MotionAgent("m", "Hallway", transport, sensor)

    agent._shutdown()

    assert sensor.closed is True
    assert transport.closed is True
