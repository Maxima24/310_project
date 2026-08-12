"""How an agent talks to the hub.

``Transport`` is an interface on purpose. The hub/agent split means swapping HTTP
for MQTT (roadmap item 4) is a constructor change in ``run_agent.py``, not a
rewrite of the agent logic — ``BaseAgent`` never imports ``requests``.
"""

from __future__ import annotations

import logging
import random
import threading
from abc import ABC, abstractmethod
from collections import deque

import requests

from .contracts import AgentDescriptor, SensorEvent

log = logging.getLogger(__name__)

#: Cap on locally buffered events during a hub outage. Bounded so a long outage
#: cannot exhaust memory on a Raspberry Pi; the oldest are dropped first.
EVENT_QUEUE_MAX = 500


class TransportError(RuntimeError):
    """Raised when the hub could not be reached or refused the payload."""


class Transport(ABC):
    """Everything an agent needs from the outside world."""

    @abstractmethod
    def register(self, descriptor: AgentDescriptor) -> None:
        """Announce this agent. Must be idempotent — agents re-register on restart."""

    @abstractmethod
    def heartbeat(self, agent_id: str) -> None:
        """Prove liveness. Silence past the hub's timeout raises an ``agent_offline`` alert."""

    @abstractmethod
    def publish_event(self, event: SensorEvent) -> None:
        """Report one sensor observation."""

    @abstractmethod
    def close(self) -> None:
        """Release sockets/handles."""


class HttpTransport(Transport):
    """REST transport with the durability an unattended sensor needs.

    Three behaviours matter more than they look:

    * **Backoff with jitter** — agents commonly boot before the hub (compose
      starts them together), so a connection error is expected, not exceptional.
      Jitter stops a fleet of agents retrying in lockstep.
    * **404 means re-register** — if the hub's database is reset, an agent that
      only ever heartbeats would 404 forever. Treating 404 as "announce yourself
      again" makes the fleet self-healing with no human restarting anything.
    * **A bounded local queue** — events that cannot be delivered are buffered and
      flushed oldest-first on the next success, so a brief outage does not silently
      lose the motion event that mattered.
    """

    def __init__(
        self,
        hub_url: str,
        api_key: str,
        *,
        timeout: float = 5.0,
        max_backoff: float = 30.0,
        queue_max: int = EVENT_QUEUE_MAX,
    ) -> None:
        self._base = hub_url.rstrip("/")
        self._timeout = timeout
        self._max_backoff = max_backoff
        self._session = requests.Session()
        self._session.headers.update(
            {"x-agent-key": api_key, "Content-Type": "application/json"}
        )
        self._pending: deque[SensorEvent] = deque(maxlen=queue_max)
        # register()/publish_event() run on the main thread while heartbeat() runs
        # on its own; both can trigger a re-register.
        self._lock = threading.Lock()
        self._descriptor: AgentDescriptor | None = None
        self._queue_full_warned = False

    # -- Transport ---------------------------------------------------------

    def register(self, descriptor: AgentDescriptor) -> None:
        with self._lock:
            self._descriptor = descriptor
        self._post("/agents/register", descriptor.to_payload())
        log.info("Registered with hub at %s as %s", self._base, descriptor.id)

    def heartbeat(self, agent_id: str) -> None:
        self._post(f"/agents/{agent_id}/heartbeat", None, allow_reregister=True)

    def publish_event(self, event: SensorEvent) -> None:
        # Drain anything buffered from an earlier outage first so the hub receives
        # events in the order they happened.
        self._flush_pending()
        try:
            self._post("/events", event.to_payload(), allow_reregister=True)
        except TransportError:
            self._enqueue(event)
            raise

    def close(self) -> None:
        self._session.close()

    # -- internals ---------------------------------------------------------

    def _enqueue(self, event: SensorEvent) -> None:
        if len(self._pending) == self._pending.maxlen and not self._queue_full_warned:
            log.warning(
                "Local event queue is full (%s) — oldest events will be dropped "
                "until the hub is reachable",
                self._pending.maxlen,
            )
            self._queue_full_warned = True
        self._pending.append(event)
        log.debug("Buffered event locally (%s pending)", len(self._pending))

    def _flush_pending(self) -> None:
        while self._pending:
            queued = self._pending[0]
            try:
                self._post("/events", queued.to_payload(), allow_reregister=True)
            except TransportError:
                return  # still unreachable; keep the backlog for the next attempt
            self._pending.popleft()
            self._queue_full_warned = False
            log.info("Flushed buffered event (%s remaining)", len(self._pending))

    def _post(
        self,
        path: str,
        payload: dict | None,
        *,
        allow_reregister: bool = False,
    ) -> None:
        """One attempt. Raises TransportError on any failure — retries live in the caller's loop."""
        url = f"{self._base}{path}"
        try:
            response = self._session.post(url, json=payload, timeout=self._timeout)
        except requests.RequestException as exc:
            raise TransportError(f"{url} unreachable: {exc}") from exc

        if response.status_code == 404 and allow_reregister:
            log.warning("Hub does not know this agent (404) — re-registering")
            if self._re_register():
                # Retry once now that the agent exists again.
                try:
                    response = self._session.post(url, json=payload, timeout=self._timeout)
                except requests.RequestException as exc:
                    raise TransportError(f"{url} unreachable after re-register: {exc}") from exc
            else:
                raise TransportError("re-registration failed")

        if response.status_code == 401:
            # Never retried by the caller in a tight loop without backoff, but this
            # is operator error (wrong AGENT_API_KEY) and worth saying plainly.
            raise TransportError(
                "hub rejected the API key (401) — check AGENT_API_KEY matches the hub's"
            )

        if not response.ok:
            raise TransportError(f"{url} returned {response.status_code}: {response.text[:200]}")

    def _re_register(self) -> bool:
        with self._lock:
            descriptor = self._descriptor
        if descriptor is None:
            return False
        try:
            self._post("/agents/register", descriptor.to_payload())
            return True
        except TransportError as exc:
            log.warning("Re-registration failed: %s", exc)
            return False

    def backoff_delay(self, attempt: int) -> float:
        """Exponential backoff with full jitter, capped.

        Jitter matters when a fleet restarts together: without it every agent
        retries on the same tick and hammers a hub that is still starting up.
        """
        base = min(self._max_backoff, 2.0**attempt)
        return random.uniform(base / 2, base)


class MqttTransport(Transport):
    """Placeholder for roadmap item 4.

    At 20+ agents or on a flaky network, MQTT (Mosquitto + ``paho-mqtt`` here,
    ``@nestjs/microservices`` on the hub) beats HTTP polling. Because ``BaseAgent``
    only ever touches the ``Transport`` interface, that migration replaces this
    class and one line of ``run_agent.py`` — no agent logic changes.
    """

    def __init__(self, *_args: object, **_kwargs: object) -> None:
        raise NotImplementedError(
            "MQTT transport is not implemented yet (roadmap item 4). Use HttpTransport."
        )

    def register(self, descriptor: AgentDescriptor) -> None:  # pragma: no cover
        raise NotImplementedError

    def heartbeat(self, agent_id: str) -> None:  # pragma: no cover
        raise NotImplementedError

    def publish_event(self, event: SensorEvent) -> None:  # pragma: no cover
        raise NotImplementedError

    def close(self) -> None:  # pragma: no cover
        raise NotImplementedError
