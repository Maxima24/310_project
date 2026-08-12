"""HttpTransport durability: buffering, ordered flush, and 404 re-registration.

These cover the failure modes an unattended sensor actually hits — the hub booting
after the agent, a network blip mid-report, and a hub database that was reset.
"""

from __future__ import annotations

import pytest
import requests
import responses

from security_agent.contracts import AgentDescriptor, AgentType, EventType, SensorEvent
from security_agent.transport import HttpTransport, TransportError

HUB = "http://hub.test:3000"
KEY = "test-key"

DESCRIPTOR = AgentDescriptor(id="motion-hallway", type=AgentType.MOTION, location="Hallway")


def make_event(index: int) -> SensorEvent:
    return SensorEvent(
        agent_id="motion-hallway", type=EventType.MOTION_DETECTED, metadata={"seq": index}
    )


@pytest.fixture
def transport() -> HttpTransport:
    return HttpTransport(HUB, KEY, timeout=0.5)


# -- headers -----------------------------------------------------------------


@responses.activate
def test_sends_the_api_key_header_the_hub_requires(transport: HttpTransport) -> None:
    responses.post(f"{HUB}/agents/register", json={}, status=200)

    transport.register(DESCRIPTOR)

    assert responses.calls[0].request.headers["x-agent-key"] == KEY


# -- buffering and flush -----------------------------------------------------


@responses.activate
def test_unreachable_hub_buffers_the_event_and_raises(transport: HttpTransport) -> None:
    responses.post(f"{HUB}/events", body=requests.ConnectionError("refused"))

    with pytest.raises(TransportError):
        transport.publish_event(make_event(1))

    assert len(transport._pending) == 1


@responses.activate
def test_buffered_events_flush_oldest_first_once_the_hub_returns(
    transport: HttpTransport,
) -> None:
    responses.post(f"{HUB}/events", body=requests.ConnectionError("refused"))
    for index in (1, 2):
        with pytest.raises(TransportError):
            transport.publish_event(make_event(index))

    responses.reset()
    responses.post(f"{HUB}/events", json={}, status=201)

    transport.publish_event(make_event(3))

    # Order matters: an out-of-order flush would scramble the hub's event log.
    sequences = [responses.calls[i].request.body for i in range(len(responses.calls))]
    assert len(sequences) == 3
    assert b'"seq": 1' in sequences[0]
    assert b'"seq": 2' in sequences[1]
    assert b'"seq": 3' in sequences[2]
    assert len(transport._pending) == 0


@responses.activate
def test_the_local_queue_is_bounded_so_a_long_outage_cannot_exhaust_memory() -> None:
    transport = HttpTransport(HUB, KEY, timeout=0.5, queue_max=3)
    responses.post(f"{HUB}/events", body=requests.ConnectionError("refused"))

    for index in range(10):
        with pytest.raises(TransportError):
            transport.publish_event(make_event(index))

    assert len(transport._pending) == 3
    # Oldest dropped, newest kept — recent activity is the more useful record.
    assert transport._pending[-1].metadata["seq"] == 9


# -- 404 re-registration -----------------------------------------------------


@responses.activate
def test_a_404_heartbeat_triggers_re_registration_then_retries(
    transport: HttpTransport,
) -> None:
    # This is how a fleet self-heals after the hub's database is wiped: without it
    # an agent that only heartbeats would 404 forever.
    transport._descriptor = DESCRIPTOR
    responses.post(f"{HUB}/agents/motion-hallway/heartbeat", json={}, status=404)
    responses.post(f"{HUB}/agents/register", json={}, status=200)
    responses.post(f"{HUB}/agents/motion-hallway/heartbeat", json={}, status=200)

    transport.heartbeat("motion-hallway")

    paths = [call.request.url for call in responses.calls]
    assert paths == [
        f"{HUB}/agents/motion-hallway/heartbeat",
        f"{HUB}/agents/register",
        f"{HUB}/agents/motion-hallway/heartbeat",
    ]


@responses.activate
def test_a_404_before_registration_fails_rather_than_looping(
    transport: HttpTransport,
) -> None:
    responses.post(f"{HUB}/agents/motion-hallway/heartbeat", json={}, status=404)

    with pytest.raises(TransportError, match="re-registration failed"):
        transport.heartbeat("motion-hallway")


# -- error reporting ---------------------------------------------------------


@responses.activate
def test_a_401_names_the_env_var_to_fix(transport: HttpTransport) -> None:
    responses.post(f"{HUB}/events", json={"message": "Unauthorized"}, status=401)

    with pytest.raises(TransportError, match="AGENT_API_KEY"):
        transport.publish_event(make_event(1))


@responses.activate
def test_a_400_surfaces_the_hubs_validation_message(transport: HttpTransport) -> None:
    responses.post(f"{HUB}/events", json={"message": "type must be one of..."}, status=400)

    with pytest.raises(TransportError, match="400"):
        transport.publish_event(make_event(1))


# -- backoff -----------------------------------------------------------------


def test_backoff_grows_and_is_capped(transport: HttpTransport) -> None:
    early = transport.backoff_delay(0)
    late = transport.backoff_delay(20)

    assert 0 < early <= 1.0
    # Capped so a long outage does not stretch retries to hours.
    assert late <= 30.0


def test_backoff_is_jittered_so_a_restarting_fleet_does_not_retry_in_lockstep(
    transport: HttpTransport,
) -> None:
    delays = {transport.backoff_delay(5) for _ in range(20)}

    assert len(delays) > 1
