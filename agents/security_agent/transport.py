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
from .credentials import TokenStore

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
        bootstrap_key: str,
        *,
        token_store: TokenStore | None = None,
        timeout: float = 5.0,
        max_backoff: float = 30.0,
        queue_max: int = EVENT_QUEUE_MAX,
    ) -> None:
        self._base = hub_url.rstrip("/")
        self._timeout = timeout
        self._max_backoff = max_backoff
        self._session = requests.Session()
        self._session.headers.update({"Content-Type": "application/json"})
        self._bootstrap_key = bootstrap_key
        self._token_store = token_store
        #: The agent's own token, issued at enrollment. Loaded from disk if present so
        #: a restart does not force a rotation.
        self._token: str | None = token_store.load() if token_store else None
        self._pending: deque[SensorEvent] = deque(maxlen=queue_max)
        # register()/publish_event() run on the main thread while heartbeat() runs
        # on its own; both can trigger a re-enrollment, and both touch _token.
        self._lock = threading.Lock()
        self._descriptor: AgentDescriptor | None = None
        self._queue_full_warned = False

    # -- Transport ---------------------------------------------------------

    def register(self, descriptor: AgentDescriptor) -> None:
        """Enrolls with the bootstrap key and stores the issued token.

        Skipped entirely when a token is already on disk: re-enrolling would rotate
        the token for no reason, and the hub logs every rotation as security-relevant.
        A stale token is detected lazily instead — the first 401 triggers enrollment.
        """
        with self._lock:
            self._descriptor = descriptor
            have_token = self._token is not None

        if have_token:
            log.info("Reusing stored token for %s (no re-enrollment needed)", descriptor.id)
            return

        self._enroll(descriptor)

    def heartbeat(self, agent_id: str) -> None:
        self._post(f"/agents/{agent_id}/heartbeat", None, allow_recovery=True)

    def publish_event(self, event: SensorEvent) -> None:
        # Drain anything buffered from an earlier outage first so the hub receives
        # events in the order they happened.
        self._flush_pending()
        try:
            self._post("/events", event.to_payload(), allow_recovery=True)
        except TransportError:
            self._enqueue(event)
            raise

    def close(self) -> None:
        self._session.close()

    @property
    def token(self) -> str | None:
        """The issued agent token, once enrolled. Used by MqttTransport to authenticate."""
        with self._lock:
            return self._token

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
                self._post("/events", queued.to_payload(), allow_recovery=True)
            except TransportError:
                return  # still unreachable; keep the backlog for the next attempt
            self._pending.popleft()
            self._queue_full_warned = False
            log.info("Flushed buffered event (%s remaining)", len(self._pending))

    # -- enrollment --------------------------------------------------------

    def _enroll(self, descriptor: AgentDescriptor) -> None:
        """Exchanges the bootstrap key for this agent's own token."""
        url = f"{self._base}/agents/register"
        try:
            response = self._session.post(
                url,
                json=descriptor.to_payload(),
                headers={"Authorization": f"Bearer {self._bootstrap_key}"},
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            raise TransportError(f"{url} unreachable: {exc}") from exc

        if response.status_code in (401, 403):
            raise TransportError(
                "hub rejected the bootstrap key (%s) - check AGENT_BOOTSTRAP_KEY matches "
                "the hub's AGENT_BOOTSTRAP_KEY" % response.status_code
            )
        if not response.ok:
            raise TransportError(f"{url} returned {response.status_code}: {response.text[:200]}")

        try:
            token = response.json()["enrollment"]["token"]
        except (ValueError, KeyError, TypeError) as exc:
            raise TransportError(
                f"hub did not return an enrollment token: {response.text[:200]}"
            ) from exc

        with self._lock:
            self._token = token
        if self._token_store:
            self._token_store.save(token)

        log.info("Enrolled with hub at %s as %s", self._base, descriptor.id)

    def _reenroll(self) -> bool:
        """Re-runs enrollment after the hub rejected or did not recognise our token."""
        with self._lock:
            descriptor = self._descriptor
            self._token = None
        if self._token_store:
            # Drop the stale file so a crash between here and a successful enrollment
            # does not leave a token that will never work again.
            self._token_store.clear()
        if descriptor is None:
            return False
        try:
            self._enroll(descriptor)
            return True
        except TransportError as exc:
            log.warning("Re-enrollment failed: %s", exc)
            return False

    # -- requests ----------------------------------------------------------

    def _post(
        self,
        path: str,
        payload: dict | None,
        *,
        allow_recovery: bool = False,
    ) -> None:
        """One attempt using the agent's own token.

        Retries live in the caller's loop; this raises TransportError on any failure.

        Two responses trigger re-enrollment when ``allow_recovery`` is set:

        * **401/403** — the token is stale. Happens when the hub rotated it, or when
          the agent's stored token predates a database reset.
        * **404** — the hub has no such agent, e.g. its database was wiped.

        Either way the fix is the same, and doing it automatically is what makes the
        fleet self-healing rather than needing a human to restart agents.
        """
        url = f"{self._base}{path}"

        with self._lock:
            token = self._token

        if token is None:
            if not (allow_recovery and self._reenroll()):
                raise TransportError("no agent token — enroll first")
            with self._lock:
                token = self._token

        response = self._attempt(url, payload, token)

        if response.status_code in (401, 403, 404) and allow_recovery:
            log.warning(
                "Hub rejected our credential (%s) — re-enrolling", response.status_code
            )
            if not self._reenroll():
                raise TransportError("re-enrollment failed")
            with self._lock:
                token = self._token
            response = self._attempt(url, payload, token)

        if response.status_code in (401, 403):
            raise TransportError(
                f"hub rejected the agent token ({response.status_code}) even after re-enrolling"
            )

        if not response.ok:
            raise TransportError(f"{url} returned {response.status_code}: {response.text[:200]}")

    def _attempt(self, url: str, payload: dict | None, token: str | None):
        try:
            return self._session.post(
                url,
                json=payload,
                headers={"Authorization": f"Bearer {token}"},
                timeout=self._timeout,
            )
        except requests.RequestException as exc:
            raise TransportError(f"{url} unreachable: {exc}") from exc

    def backoff_delay(self, attempt: int) -> float:
        """Exponential backoff with full jitter, capped.

        Jitter matters when a fleet restarts together: without it every agent
        retries on the same tick and hammers a hub that is still starting up.
        """
        base = min(self._max_backoff, 2.0**attempt)
        return random.uniform(base / 2, base)


class MqttTransport(Transport):
    """MQTT transport (roadmap item 4, implemented).

    At 20+ agents or on a flaky network, MQTT beats HTTP polling: one persistent
    connection per agent instead of a TCP handshake per heartbeat, and the broker
    absorbs reconnects.

    That this is a drop-in replacement is the payoff of the Transport interface —
    ``BaseAgent`` never imported ``requests``, so nothing above this line changes.

    Two deliberate asymmetries with HTTP:

    * **Enrollment still uses HTTP.** Registration is a request/response exchange that
      returns a secret; modelling it over pub/sub would mean a reply-topic dance for
      no benefit. The agent enrolls once over HTTP, then publishes over MQTT.
    * **QoS 1, not 0 or 2.** Losing a motion event is unacceptable, so QoS 0 is out.
      QoS 2's exactly-once handshake costs two extra round trips per message, and the
      hub already tolerates duplicates (the alert dedup window collapses them), so
      at-least-once is the right trade.
    """

    #: Topic layout mirrors the REST paths, so the hub's routing reads the same.
    TOPIC_EVENT = "cpe310/agents/{agent_id}/events"
    TOPIC_HEARTBEAT = "cpe310/agents/{agent_id}/heartbeat"

    def __init__(
        self,
        broker_host: str,
        broker_port: int,
        hub_url: str,
        bootstrap_key: str,
        *,
        token_store: TokenStore | None = None,
        agent_id: str | None = None,
        keepalive: int = 30,
        timeout: float = 5.0,
    ) -> None:
        try:
            import paho.mqtt.client as mqtt  # noqa: PLC0415 - lazy, like cv2/boto3
        except ImportError as exc:
            raise TransportError(
                "MQTT transport needs paho-mqtt: pip install -r requirements.txt"
            ) from exc

        self._mqtt = mqtt
        self._host = broker_host
        self._port = broker_port
        self._keepalive = keepalive
        #: Enrollment happens over HTTP; this handles that half and owns the token.
        self._http = HttpTransport(
            hub_url, bootstrap_key, token_store=token_store, timeout=timeout
        )
        self._client = mqtt.Client(
            client_id=f"cpe310-{agent_id or 'agent'}",
            protocol=mqtt.MQTTv311,
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        )
        self._connected = threading.Event()
        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect

    # -- Transport ---------------------------------------------------------

    def register(self, descriptor: AgentDescriptor) -> None:
        # Enroll over HTTP first so the token is available to authenticate publishes.
        self._http.register(descriptor)

        token = self._http.token
        if token:
            # The broker authenticates the connection; the hub still needs to know
            # which agent a message belongs to, so the token travels as the MQTT
            # username. A shared bus means anyone who can publish could otherwise
            # claim any agent id in the topic.
            self._client.username_pw_set(descriptor.id, token)

        self._client.connect_async(self._host, self._port, keepalive=self._keepalive)
        self._client.loop_start()

        if not self._connected.wait(timeout=10.0):
            raise TransportError(f"could not connect to MQTT broker at {self._host}:{self._port}")

        log.info("Connected to MQTT broker %s:%s as %s", self._host, self._port, descriptor.id)

    def heartbeat(self, agent_id: str) -> None:
        self._publish(self.TOPIC_HEARTBEAT.format(agent_id=agent_id), {"agentId": agent_id})

    def publish_event(self, event: SensorEvent) -> None:
        self._publish(self.TOPIC_EVENT.format(agent_id=event.agent_id), event.to_payload())

    def _authenticated(self, payload: dict) -> dict:
        """Adds the agent token to the payload.

        MQTT does not propagate a publisher's username to subscribers, so broker-level
        credentials alone cannot tell the hub *which* agent a message came from — it
        would have to trust the agent id in the topic, and on a shared bus any
        publisher could put someone else's id there. Carrying the token in the payload
        gives the hub the same proof of identity the HTTP header provides.

        The broker connection should still be authenticated and, off localhost, TLS —
        this is authentication for the hub, not a substitute for transport security.
        """
        token = self._http.token
        if not token:
            raise TransportError("no agent token — enroll before publishing over MQTT")
        return {**payload, "token": token}

    def close(self) -> None:
        try:
            self._client.loop_stop()
            self._client.disconnect()
        finally:
            self._http.close()

    # -- internals ---------------------------------------------------------

    def _publish(self, topic: str, payload: dict) -> None:
        import json  # noqa: PLC0415

        info = self._client.publish(topic, json.dumps(self._authenticated(payload)), qos=1)
        # rc is checked rather than waiting for the broker ack: blocking the poll loop
        # on a network round trip is exactly what MQTT is meant to avoid, and paho
        # queues the message for delivery on reconnect.
        if info.rc != self._mqtt.MQTT_ERR_SUCCESS:
            raise TransportError(f"MQTT publish to {topic} failed (rc={info.rc})")

    def _on_connect(self, _client, _userdata, _flags, reason_code, _properties=None) -> None:
        if reason_code == 0:
            self._connected.set()
        else:
            log.warning("MQTT connection refused: %s", reason_code)

    def _on_disconnect(self, _client, _userdata, _flags, reason_code, _properties=None) -> None:
        self._connected.clear()
        # paho's loop reconnects on its own; this is only worth noting.
        log.warning("MQTT disconnected (%s) — paho will retry", reason_code)

    def backoff_delay(self, attempt: int) -> float:
        return self._http.backoff_delay(attempt)
