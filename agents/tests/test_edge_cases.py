"""Failure-mode behaviour for the agents.

Each test here corresponds to a way an unattended sensor can fail badly — a thread
dying silently, a blind camera reporting healthy, a flag that makes the process spin
at 100% CPU. The common thread: the hub must never be told an agent is fine when it
is not, and an agent must never look crashed when it stopped cleanly.
"""

from __future__ import annotations

import argparse
import threading

import pytest

import run_agent
from security_agent.agents import CameraAgent, DoorAgent, MotionAgent
from security_agent.agents.camera import MAX_REOPEN_ATTEMPTS
from security_agent.base import AgentConfigurationError, BaseAgent
from security_agent.contracts import AgentDescriptor, AgentType, EventType, SensorEvent
from security_agent.transport import Transport, TransportError


class StubTransport(Transport):
    def __init__(self) -> None:
        self.events: list[SensorEvent] = []
        self.heartbeats = 0
        self.closed = False

    def register(self, descriptor: AgentDescriptor) -> None:
        return None

    def heartbeat(self, agent_id: str) -> None:
        self.heartbeats += 1

    def publish_event(self, event: SensorEvent) -> None:
        self.events.append(event)

    def close(self) -> None:
        self.closed = True


class ExplodingSensor:
    """A sensor whose read() always raises something unexpected."""

    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    def read(self) -> bool:
        raise self._exc

    def close(self) -> None:
        return None


# -- the heartbeat thread must never die silently -----------------------------


class BrokenHeartbeatTransport(StubTransport):
    """Raises a non-TransportError, as a bug or an unexpected library error would."""

    def __init__(self, failures: int) -> None:
        super().__init__()
        self._remaining = failures

    def heartbeat(self, agent_id: str) -> None:
        if self._remaining > 0:
            self._remaining -= 1
            raise ValueError("something unexpected")
        super().heartbeat(agent_id)


def test_heartbeat_loop_survives_an_unexpected_exception() -> None:
    """The worst failure mode in the system.

    If the heartbeat thread dies, the process keeps polling and reporting events while
    never beating again — so the hub raises agent_offline, a *tamper alert for an
    agent that is demonstrably alive*. Catching only TransportError allowed exactly
    that, so the loop now absorbs anything.
    """
    transport = BrokenHeartbeatTransport(failures=2)
    agent = MotionAgent("m", "Hallway", transport, ExplodingSensor(ValueError("x")))
    agent.heartbeat_interval = 0.01
    # backoff_delay is absent on this transport, so BaseAgent falls back to 2**attempt;
    # patch it to keep the test fast.
    agent._backoff = lambda attempt: 0.01  # type: ignore[method-assign]

    thread = threading.Thread(target=agent._heartbeat_loop, daemon=True)
    thread.start()
    # Long enough to fail twice and then succeed.
    threading.Event().wait(0.4)
    agent.stop()
    thread.join(timeout=2.0)

    assert transport.heartbeats >= 1, "loop gave up after the unexpected error"
    assert not thread.is_alive()


# -- ordinary sensor faults are survivable; config faults are not -------------


def test_poll_loop_keeps_running_when_a_sensor_misbehaves() -> None:
    transport = StubTransport()
    agent = MotionAgent("m", "Hallway", transport, ExplodingSensor(OSError("i2c read failed")))
    agent.poll_interval = 0.01

    thread = threading.Thread(target=agent._poll_loop, daemon=True)
    thread.start()
    threading.Event().wait(0.15)
    still_running = thread.is_alive()
    agent.stop()
    thread.join(timeout=2.0)

    # A flaky sensor is a maintenance problem, not a reason to stop reporting
    # liveness — the process is alive and the hub should keep seeing it.
    assert still_running


def test_poll_loop_does_not_swallow_a_configuration_error() -> None:
    """Retrying a missing OpenCV forever helps nobody.

    Before this, a camera agent with no cv2 logged the same traceback every 200ms
    while the hub cheerfully reported it as online.
    """
    transport = StubTransport()
    agent = MotionAgent(
        "m",
        "Hallway",
        transport,
        ExplodingSensor(AgentConfigurationError("no camera")),
    )
    agent.poll_interval = 0.01

    with pytest.raises(AgentConfigurationError):
        agent._poll_loop()


def test_run_still_closes_the_transport_when_a_configuration_error_escapes() -> None:
    transport = StubTransport()
    agent = MotionAgent(
        "m", "Hallway", transport, ExplodingSensor(AgentConfigurationError("no camera"))
    )
    agent.poll_interval = 0.01

    with pytest.raises(AgentConfigurationError):
        agent.run()

    assert transport.closed is True


# -- a blind camera must not report healthy ----------------------------------


def test_camera_gives_up_after_repeated_reopen_failures() -> None:
    """A camera that cannot deliver frames is blind.

    A blind camera that keeps heartbeating is worse than one that stops: the hub
    reports it healthy forever. Exiting lets agent_offline tell the truth.
    """
    agent = CameraAgent("c", "Lobby", StubTransport(), real=True, source="rtsp://dead")
    agent._reopen_attempts = MAX_REOPEN_ATTEMPTS

    with pytest.raises(AgentConfigurationError, match="agent_offline"):
        agent._reopen()


def test_camera_reopen_resets_the_background_model() -> None:
    # The scene may have changed while the stream was down; reusing the old MOG2
    # model would flag the entire frame as motion on the first frame back.
    agent = CameraAgent("c", "Lobby", StubTransport(), real=True, source="rtsp://blip")
    agent._cv2 = object()
    agent._subtractor = object()
    agent._frame_index = 900
    agent._read_failures = 25

    agent._reopen()

    assert agent._subtractor is None
    assert agent._cv2 is None
    assert agent._frame_index == 0
    assert agent._read_failures == 0


# -- CLI guards ---------------------------------------------------------------


@pytest.mark.parametrize("bad", ["0", "-1", "-0.5"])
def test_interval_must_be_positive(bad: str) -> None:
    # A zero interval turns the poll loop into a busy-wait pinning a core, which
    # presents as "the agent just hangs".
    with pytest.raises(argparse.ArgumentTypeError):
        run_agent.positive_float(bad)


def test_interval_rejects_non_numbers() -> None:
    with pytest.raises(argparse.ArgumentTypeError, match="not a number"):
        run_agent.positive_float("fast")


def test_cooldown_may_be_zero_but_not_negative() -> None:
    assert run_agent.non_negative_float("0") == 0.0
    with pytest.raises(argparse.ArgumentTypeError):
        run_agent.non_negative_float("-1")


def test_parser_rejects_a_zero_interval_end_to_end() -> None:
    with pytest.raises(SystemExit):
        run_agent.build_parser().parse_args(
            ["--type", "motion", "--id", "m", "--interval", "0"]
        )


def test_missing_api_key_exits_with_guidance(monkeypatch, capsys) -> None:
    monkeypatch.delenv("AGENT_API_KEY", raising=False)

    code = run_agent.main(["--type", "motion", "--id", "m"])

    assert code == run_agent.EXIT_MISSING_KEY
    # Must name the variable and show both shells — a bare 401 loop is unhelpful.
    assert "AGENT_API_KEY" in capsys.readouterr().err


def test_gpio_stub_exits_cleanly_instead_of_tracebacking(monkeypatch, capsys) -> None:
    monkeypatch.setenv("AGENT_API_KEY", "k")

    code = run_agent.main(["--type", "motion", "--id", "m", "--real"])

    assert code == run_agent.EXIT_BAD_HARDWARE
    assert "gpiozero" in capsys.readouterr().err


# -- shutdown ----------------------------------------------------------------


def test_stop_is_idempotent_and_safe_before_run() -> None:
    agent = DoorAgent("d", "Front door", StubTransport(), ExplodingSensor(OSError("x")))

    agent.stop()
    agent.stop()

    assert agent._stop.is_set()


def test_shutdown_without_a_heartbeat_thread_does_not_raise() -> None:
    # _shutdown runs from run()'s finally, which can be reached before the thread
    # was ever started (e.g. Ctrl-C during registration backoff).
    transport = StubTransport()
    agent: BaseAgent = DoorAgent("d", "Front door", transport, ExplodingSensor(OSError("x")))

    agent._shutdown()

    assert transport.closed is True


def test_door_agent_reports_both_edges_of_a_full_cycle() -> None:
    class Toggling:
        def __init__(self) -> None:
            self.values = [False, True, False]
            self.i = 0

        def read(self) -> bool:
            v = self.values[min(self.i, len(self.values) - 1)]
            self.i += 1
            return v

        def close(self) -> None:
            return None

    agent = DoorAgent("d", "Front door", StubTransport(), Toggling())
    types = [e.type for _ in range(3) for e in agent.poll()]

    assert types == [EventType.DOOR_OPENED, EventType.DOOR_CLOSED]


def test_transport_error_during_publish_does_not_stop_the_agent() -> None:
    class FailingTransport(StubTransport):
        def publish_event(self, event: SensorEvent) -> None:
            raise TransportError("hub down")

    agent = MotionAgent("m", "Hallway", FailingTransport(), _AlwaysOn(), cooldown=0.0)

    # _publish swallows TransportError: the transport has already buffered the event
    # locally, and a dropped report must not take the agent down with it.
    agent._publish(agent.make_event(EventType.MOTION_DETECTED))


class _AlwaysOn:
    def read(self) -> bool:
        return True

    def close(self) -> None:
        return None
