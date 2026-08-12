"""The agent lifecycle: register, heartbeat, poll, report, shut down cleanly."""

from __future__ import annotations

import logging
import signal
import threading
from abc import ABC, abstractmethod
from types import FrameType
from typing import Any

from .contracts import AgentDescriptor, AgentType, EventType, SensorEvent
from .transport import Transport, TransportError

log = logging.getLogger(__name__)

AGENT_VERSION = "1.0.0"


class AgentConfigurationError(RuntimeError):
    """An unrecoverable setup problem: missing OpenCV, an unopenable camera, a bad pin.

    Distinguished from ``TransportError`` because retrying cannot help. The poll loop
    deliberately does NOT swallow this — an agent that cannot ever produce a reading
    should exit with a clear message rather than log the same traceback every 200ms
    while the hub happily reports it as online.
    """


class BaseAgent(ABC):
    """Common lifecycle for every collector agent.

    Subclasses implement exactly two things: what type they are, and what a poll
    observes. Everything else — registration, heartbeating, retry, shutdown — is
    handled here so a new sensor type is a ~20 line file.
    """

    def __init__(
        self,
        agent_id: str,
        location: str,
        transport: Transport,
        *,
        poll_interval: float = 1.0,
        heartbeat_interval: float = 10.0,
        capabilities: list[str] | None = None,
    ) -> None:
        self.agent_id = agent_id
        self.location = location
        self.transport = transport
        self.poll_interval = poll_interval
        self.heartbeat_interval = heartbeat_interval
        self.capabilities = capabilities or []
        self._stop = threading.Event()
        self._heartbeat_thread: threading.Thread | None = None

    # -- subclass contract -------------------------------------------------

    @property
    @abstractmethod
    def agent_type(self) -> AgentType: ...

    @abstractmethod
    def poll(self) -> list[SensorEvent]:
        """Read the sensor once and return any events observed.

        Returning a list rather than a single optional event keeps the door agent
        honest: a poll that sees a closed-then-opened transition has two things to
        report, and a camera may want to batch.
        """

    def on_shutdown(self) -> None:
        """Release sensor handles. Overridden where there is something to close."""

    # -- helpers for subclasses -------------------------------------------

    def descriptor(self) -> AgentDescriptor:
        return AgentDescriptor(
            id=self.agent_id,
            type=self.agent_type,
            location=self.location,
            version=AGENT_VERSION,
            capabilities=self.capabilities,
        )

    def make_event(self, event_type: EventType, **metadata: Any) -> SensorEvent:
        return SensorEvent(agent_id=self.agent_id, type=event_type, metadata=metadata)

    # -- lifecycle ---------------------------------------------------------

    def run(self) -> None:
        """Blocks until SIGINT/SIGTERM. Returns normally on a clean shutdown."""
        self._install_signal_handlers()

        self._register_with_retry()

        self._heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop, name=f"{self.agent_id}-heartbeat", daemon=True
        )
        self._heartbeat_thread.start()

        log.info(
            "%s agent %s polling every %.1fs (heartbeat every %.0fs)",
            self.agent_type,
            self.agent_id,
            self.poll_interval,
            self.heartbeat_interval,
        )

        try:
            self._poll_loop()
        finally:
            self._shutdown()

    def stop(self) -> None:
        """Asks both loops to exit. Safe to call from a signal handler."""
        self._stop.set()

    # -- internals ---------------------------------------------------------

    def _install_signal_handlers(self) -> None:
        def handler(signum: int, _frame: FrameType | None) -> None:
            log.info("Received signal %s — shutting down", signal.Signals(signum).name)
            self.stop()

        signal.signal(signal.SIGINT, handler)
        # Docker sends SIGTERM on `compose stop`; without this the container would
        # be SIGKILLed after the grace period and look like a crash.
        try:
            signal.signal(signal.SIGTERM, handler)
        except (AttributeError, ValueError):  # pragma: no cover - platform dependent
            log.debug("SIGTERM not available on this platform")

    def _register_with_retry(self) -> None:
        """Retries indefinitely: agents commonly start before the hub is listening."""
        attempt = 0
        while not self._stop.is_set():
            try:
                self.transport.register(self.descriptor())
                return
            except TransportError as exc:
                delay = self._backoff(attempt)
                log.warning(
                    "Registration failed (%s); retrying in %.1fs", exc, delay
                )
                if self._stop.wait(delay):
                    return
                attempt += 1

    def _poll_loop(self) -> None:
        consecutive_failures = 0

        while not self._stop.is_set():
            try:
                events = self.poll()
                consecutive_failures = 0
            except AgentConfigurationError:
                # Unrecoverable — let it propagate so run() unwinds and the CLI can
                # print a fix. Retrying a missing OpenCV forever helps nobody.
                raise
            except Exception:  # noqa: BLE001 - a flaky sensor must not kill the agent
                consecutive_failures += 1
                log.exception("Sensor poll failed (%s in a row); continuing", consecutive_failures)
                events = []
                # A sensor failing every single poll is a broken sensor, not a blip.
                # Back off so the log stays readable and the CPU stays idle; the
                # heartbeat thread keeps running, so the hub still sees the agent as
                # online — which is accurate, the process is alive.
                if consecutive_failures >= 5:
                    self._stop.wait(min(30.0, self.poll_interval * consecutive_failures))

            for event in events:
                self._publish(event)

            # wait() rather than sleep() so a shutdown signal is acted on
            # immediately instead of after the current interval expires.
            self._stop.wait(self.poll_interval)

    def _publish(self, event: SensorEvent) -> None:
        try:
            self.transport.publish_event(event)
            log.info("Reported %s", event.type)
        except TransportError as exc:
            # The transport has already buffered it for a later flush; losing the
            # report entirely is the one outcome worth avoiding.
            log.warning("Could not report %s (%s) — buffered locally", event.type, exc)

    def _heartbeat_loop(self) -> None:
        """Runs on its own thread.

        This must not share the poll loop: a camera's frame read can block for
        longer than the heartbeat interval, and the hub would then sweep a perfectly
        healthy agent offline.
        """
        attempt = 0
        while not self._stop.is_set():
            try:
                self.transport.heartbeat(self.agent_id)
                attempt = 0
                self._stop.wait(self.heartbeat_interval)
            except TransportError as exc:
                delay = self._backoff(attempt)
                log.warning("Heartbeat failed (%s); retrying in %.1fs", exc, delay)
                self._stop.wait(delay)
                attempt += 1
            except Exception:  # noqa: BLE001
                # Catching only TransportError would let any other error kill this
                # thread silently. The process would keep polling and reporting while
                # never beating again, so the hub would raise agent_offline — a
                # tamper alert for an agent that is demonstrably alive. Staying in
                # the loop is strictly better than that.
                delay = self._backoff(attempt)
                log.exception("Unexpected heartbeat error; retrying in %.1fs", delay)
                self._stop.wait(delay)
                attempt += 1

    def _backoff(self, attempt: int) -> float:
        delay_fn = getattr(self.transport, "backoff_delay", None)
        if callable(delay_fn):
            return float(delay_fn(attempt))
        return min(30.0, 2.0**attempt)

    def _shutdown(self) -> None:
        self._stop.set()
        if self._heartbeat_thread is not None:
            self._heartbeat_thread.join(timeout=2.0)
        try:
            self.on_shutdown()
        finally:
            self.transport.close()
        log.info("Agent %s stopped", self.agent_id)
