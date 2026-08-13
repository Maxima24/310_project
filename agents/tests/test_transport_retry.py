"""HttpTransport durability and the two-credential enrollment flow (roadmap item 2).

Covers the failure modes an unattended sensor actually hits: the hub booting after
the agent, a network blip mid-report, a hub database that was reset, and a token the
hub no longer recognises.
"""

from __future__ import annotations

import json

import pytest
import requests
import responses

from security_agent.contracts import AgentDescriptor, AgentType, EventType, SensorEvent
from security_agent.credentials import TokenStore
from security_agent.transport import HttpTransport, TransportError

HUB = "http://hub.test:3000"
BOOTSTRAP = "test-bootstrap-key"
TOKEN = "ag_issued-token-value"
TOKEN2 = "ag_rotated-token-value"

DESCRIPTOR = AgentDescriptor(id="motion-hallway", type=AgentType.MOTION, location="Hallway")


def make_event(index: int) -> SensorEvent:
    return SensorEvent(
        agent_id="motion-hallway", type=EventType.MOTION_DETECTED, metadata={"seq": index}
    )


def enrollment_body(token: str = TOKEN, rotated: bool = False) -> dict:
    return {
        "agent": {"id": "motion-hallway"},
        "heartbeatIntervalMs": 10_000,
        "enrollment": {"token": token, "issuedAt": "2026-01-01T00:00:00.000Z", "rotated": rotated},
    }


@pytest.fixture
def transport() -> HttpTransport:
    """A transport with no cached token, so register() enrolls."""
    return HttpTransport(HUB, BOOTSTRAP, timeout=0.5)


@pytest.fixture
def enrolled() -> HttpTransport:
    """A transport that already holds a token, as it would after a restart."""
    t = HttpTransport(HUB, BOOTSTRAP, timeout=0.5)
    t._token = TOKEN
    t._descriptor = DESCRIPTOR
    return t


def auth_of(call) -> str:
    return call.request.headers["Authorization"]


# -- enrollment --------------------------------------------------------------


@responses.activate
def test_enrollment_uses_the_bootstrap_key_and_stores_the_issued_token(
    transport: HttpTransport,
) -> None:
    responses.post(f"{HUB}/agents/register", json=enrollment_body(), status=200)

    transport.register(DESCRIPTOR)

    assert auth_of(responses.calls[0]) == f"Bearer {BOOTSTRAP}"
    assert transport._token == TOKEN


@responses.activate
def test_events_are_sent_with_the_agent_token_not_the_bootstrap_key(
    enrolled: HttpTransport,
) -> None:
    # The whole point of roadmap 2: the long-lived bootstrap secret is used once,
    # then never again on the hot path.
    responses.post(f"{HUB}/events", json={}, status=201)

    enrolled.publish_event(make_event(1))

    assert auth_of(responses.calls[0]) == f"Bearer {TOKEN}"


@responses.activate
def test_a_rejected_bootstrap_key_names_the_env_var_to_fix(transport: HttpTransport) -> None:
    responses.post(f"{HUB}/agents/register", json={"message": "Unauthorized"}, status=401)

    with pytest.raises(TransportError, match="AGENT_BOOTSTRAP_KEY"):
        transport.register(DESCRIPTOR)


@responses.activate
def test_a_missing_enrollment_token_in_the_response_is_an_error(
    transport: HttpTransport,
) -> None:
    responses.post(f"{HUB}/agents/register", json={"agent": {"id": "x"}}, status=200)

    with pytest.raises(TransportError, match="did not return an enrollment token"):
        transport.register(DESCRIPTOR)


# -- token caching -----------------------------------------------------------


@responses.activate
def test_register_skips_enrollment_when_a_token_is_already_cached(tmp_path) -> None:
    # Re-enrolling on every restart would rotate the token needlessly and bury a
    # genuine unexpected rotation in the hub's audit log.
    store = TokenStore("motion-hallway", tmp_path)
    store.save(TOKEN)
    t = HttpTransport(HUB, BOOTSTRAP, token_store=store, timeout=0.5)

    t.register(DESCRIPTOR)

    assert len(responses.calls) == 0
    assert t._token == TOKEN


def test_a_cached_token_survives_a_restart(tmp_path) -> None:
    TokenStore("motion-hallway", tmp_path).save(TOKEN)

    revived = HttpTransport(HUB, BOOTSTRAP, token_store=TokenStore("motion-hallway", tmp_path))

    assert revived._token == TOKEN


def test_token_store_returns_none_when_no_token_was_ever_saved(tmp_path) -> None:
    assert TokenStore("nobody", tmp_path).load() is None


def test_token_files_are_per_agent(tmp_path) -> None:
    # Two agents on one host must never share a credential.
    TokenStore("a", tmp_path).save("ag_a")
    TokenStore("b", tmp_path).save("ag_b")

    assert TokenStore("a", tmp_path).load() == "ag_a"
    assert TokenStore("b", tmp_path).load() == "ag_b"


# -- credential recovery -----------------------------------------------------


@responses.activate
def test_a_stale_token_triggers_re_enrollment_then_retries(enrolled: HttpTransport) -> None:
    # Happens when the hub rotated the token, or the cached one predates a DB reset.
    responses.post(f"{HUB}/events", json={"message": "Invalid credential"}, status=401)
    responses.post(f"{HUB}/agents/register", json=enrollment_body(TOKEN2, rotated=True), status=200)
    responses.post(f"{HUB}/events", json={}, status=201)

    enrolled.publish_event(make_event(1))

    assert [c.request.url for c in responses.calls] == [
        f"{HUB}/events",
        f"{HUB}/agents/register",
        f"{HUB}/events",
    ]
    # The retry must use the NEW token, not the rejected one.
    assert auth_of(responses.calls[2]) == f"Bearer {TOKEN2}"
    assert enrolled._token == TOKEN2


@responses.activate
def test_a_404_heartbeat_triggers_re_enrollment_then_retries(enrolled: HttpTransport) -> None:
    # How the fleet self-heals after the hub's database is wiped.
    responses.post(f"{HUB}/agents/motion-hallway/heartbeat", json={}, status=404)
    responses.post(f"{HUB}/agents/register", json=enrollment_body(TOKEN2), status=200)
    responses.post(f"{HUB}/agents/motion-hallway/heartbeat", json={}, status=200)

    enrolled.heartbeat("motion-hallway")

    assert len(responses.calls) == 3
    assert auth_of(responses.calls[2]) == f"Bearer {TOKEN2}"


@responses.activate
def test_re_enrollment_clears_the_stale_token_file(tmp_path) -> None:
    # A crash between invalidation and successful re-enrollment must not leave a
    # token on disk that will never work again.
    store = TokenStore("motion-hallway", tmp_path)
    store.save(TOKEN)
    t = HttpTransport(HUB, BOOTSTRAP, token_store=store, timeout=0.5)
    t._descriptor = DESCRIPTOR
    responses.post(f"{HUB}/events", json={}, status=401)
    responses.post(f"{HUB}/agents/register", body=requests.ConnectionError("hub down"))

    with pytest.raises(TransportError):
        t.publish_event(make_event(1))

    assert store.load() is None


@responses.activate
def test_a_persistent_401_after_re_enrollment_gives_up_with_a_clear_message(
    enrolled: HttpTransport,
) -> None:
    responses.post(f"{HUB}/events", json={}, status=401)
    responses.post(f"{HUB}/agents/register", json=enrollment_body(TOKEN2), status=200)
    responses.post(f"{HUB}/events", json={}, status=401)

    with pytest.raises(TransportError, match="even after re-enrolling"):
        enrolled.publish_event(make_event(1))


@responses.activate
def test_a_403_is_treated_as_a_credential_problem_too(enrolled: HttpTransport) -> None:
    # The hub returns 403 when an agent token tries to act as a different agent.
    responses.post(f"{HUB}/events", json={"message": "cannot act as"}, status=403)
    responses.post(f"{HUB}/agents/register", json=enrollment_body(TOKEN2), status=200)
    responses.post(f"{HUB}/events", json={}, status=201)

    enrolled.publish_event(make_event(1))

    assert len(responses.calls) == 3


# -- buffering and flush -----------------------------------------------------


@responses.activate
def test_unreachable_hub_buffers_the_event_and_raises(enrolled: HttpTransport) -> None:
    responses.post(f"{HUB}/events", body=requests.ConnectionError("refused"))

    with pytest.raises(TransportError):
        enrolled.publish_event(make_event(1))

    assert len(enrolled._pending) == 1


@responses.activate
def test_buffered_events_flush_oldest_first_once_the_hub_returns(
    enrolled: HttpTransport,
) -> None:
    responses.post(f"{HUB}/events", body=requests.ConnectionError("refused"))
    for index in (1, 2):
        with pytest.raises(TransportError):
            enrolled.publish_event(make_event(index))

    responses.reset()
    responses.post(f"{HUB}/events", json={}, status=201)

    enrolled.publish_event(make_event(3))

    # Order matters: an out-of-order flush would scramble the hub's event log.
    sent = [json.loads(c.request.body)["metadata"]["seq"] for c in responses.calls]
    assert sent == [1, 2, 3]
    assert len(enrolled._pending) == 0


@responses.activate
def test_the_local_queue_is_bounded_so_a_long_outage_cannot_exhaust_memory() -> None:
    t = HttpTransport(HUB, BOOTSTRAP, timeout=0.5, queue_max=3)
    t._token = TOKEN
    responses.post(f"{HUB}/events", body=requests.ConnectionError("refused"))

    for index in range(10):
        with pytest.raises(TransportError):
            t.publish_event(make_event(index))

    assert len(t._pending) == 3
    # Oldest dropped, newest kept — recent activity is the more useful record.
    assert t._pending[-1].metadata["seq"] == 9


# -- error reporting ---------------------------------------------------------


@responses.activate
def test_a_400_surfaces_the_hubs_validation_message(enrolled: HttpTransport) -> None:
    responses.post(f"{HUB}/events", json={"message": "type must be one of..."}, status=400)

    with pytest.raises(TransportError, match="400"):
        enrolled.publish_event(make_event(1))


def test_posting_without_a_token_fails_rather_than_sending_nothing() -> None:
    t = HttpTransport(HUB, BOOTSTRAP, timeout=0.5)

    with pytest.raises(TransportError, match="no agent token"):
        t.heartbeat("motion-hallway")


# -- backoff -----------------------------------------------------------------


def test_backoff_grows_and_is_capped(transport: HttpTransport) -> None:
    assert 0 < transport.backoff_delay(0) <= 1.0
    # Capped so a long outage does not stretch retries to hours.
    assert transport.backoff_delay(20) <= 30.0


def test_backoff_is_jittered_so_a_restarting_fleet_does_not_retry_in_lockstep(
    transport: HttpTransport,
) -> None:
    assert len({transport.backoff_delay(5) for _ in range(20)}) > 1
