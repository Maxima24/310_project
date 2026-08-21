"""Tests for the ESP32-S3 firmware logic, running in CPython.

The firmware is structured so that everything involving a decision — payload shapes,
timestamp formatting, debouncing, cooldowns, the token lifecycle, the retry ladder —
imports no MicroPython module and can therefore be exercised here. Only
`platform_esp32.py` and `main.py` need a board.

That split is what makes writing this firmware without hardware defensible: the parts
asserted below are the parts that would otherwise be debugged by flashing a board and
reading a serial log.
"""

import sys
from pathlib import Path

import pytest

FIRMWARE = Path(__file__).resolve().parents[1] / "firmware" / "esp32"
sys.path.insert(0, str(FIRMWARE))

from contracts import EventType, event_payload, iso_timestamp, registration_payload  # noqa: E402
from hub_client import EventQueue, HubClient, next_backoff_ms  # noqa: E402
from sensor_logic import DoorContact, MotionDetector  # noqa: E402


# --------------------------------------------------------------------- contracts


def test_iso_timestamp_matches_the_format_the_hub_validates():
    # The hub validates this with @IsISO8601({ strict: true }). A malformed value is
    # refused outright, and the error talks about the payload rather than the clock.
    assert iso_timestamp((2026, 8, 18, 1, 23, 45, 0, 0)) == "2026-08-18T01:23:45.000Z"


def test_iso_timestamp_zero_pads_every_field():
    # "2026-8-1T1:2:3Z" is not ISO 8601 and would be rejected.
    assert iso_timestamp((2026, 1, 2, 3, 4, 5, 0, 0)) == "2026-01-02T03:04:05.000Z"


def test_registration_omits_absent_fields_rather_than_sending_null():
    # The hub marks these @IsOptional, and an explicit null fails @IsString.
    payload = registration_payload("esp32-door", "door", "Front Door")

    assert payload == {"id": "esp32-door", "type": "door", "location": "Front Door"}
    assert "version" not in payload
    assert "capabilities" not in payload


def test_event_payload_uses_camelcase_because_the_hub_is_typescript():
    payload = event_payload("esp32-door", EventType.DOOR_OPENED, "2026-08-18T01:23:45.000Z")

    assert payload["agentId"] == "esp32-door"
    assert payload["occurredAt"] == "2026-08-18T01:23:45.000Z"
    assert payload["metadata"] == {}


# ------------------------------------------------------------------------ motion


def test_motion_fires_on_the_rising_edge_only():
    # A PIR holds its output high for seconds, so "high means an event" turns one person
    # into a burst of alerts.
    detector = MotionDetector(cooldown_ms=1_000)

    assert detector.update(True, 0) is True
    assert detector.update(True, 100) is False
    assert detector.update(True, 200) is False


def test_motion_respects_the_cooldown():
    detector = MotionDetector(cooldown_ms=10_000)
    detector.update(True, 0)
    detector.update(False, 100)

    assert detector.update(True, 5_000) is False
    detector.update(False, 5_100)
    assert detector.update(True, 11_000) is True


def test_motion_survives_the_tick_counter_wrapping():
    # ticks_ms wraps roughly every 12.4 days on ESP32. A plain subtraction across the wrap
    # is hugely negative, so a cooldown comparing against it would never elapse again and
    # the board would silently stop reporting motion after a fortnight.
    detector = MotionDetector(cooldown_ms=1_000)
    near_wrap = 0x3FFFFFFF - 100

    detector.update(True, near_wrap)
    detector.update(False, near_wrap + 10)

    # 201ms later in real time, but a much SMALLER tick value after the wrap. Still inside
    # the cooldown, which is the correct answer — the point is that the elapsed time comes
    # out as 201 rather than as a huge negative number.
    assert detector.update(True, 100) is False

    detector.update(False, 150)
    # And past the cooldown it fires again, proving the counter did not get stuck.
    assert detector.update(True, 1_100) is True


def test_motion_reports_settling_until_it_has_fired():
    assert MotionDetector().settling is True


# -------------------------------------------------------------------------- door


def test_door_first_reading_establishes_a_baseline_without_emitting():
    # A door that was already shut at boot has not just shut.
    door = DoorContact(debounce_ms=50)

    assert door.update(True, 0) is None


def test_door_reports_open_and_close_transitions():
    door = DoorContact(debounce_ms=50)
    door.update(True, 0)  # baseline: circuit closed, door shut

    assert door.update(False, 100) is None  # candidate, still debouncing
    assert door.update(False, 200) == "door_opened"

    assert door.update(True, 300) is None
    assert door.update(True, 400) == "door_closed"


def test_door_debounces_the_chatter_a_reed_switch_makes():
    # A reed switch bounces as it passes the magnet; without debouncing one push becomes
    # a dozen open/close pairs.
    door = DoorContact(debounce_ms=50)
    door.update(True, 0)

    assert door.update(False, 10) is None
    assert door.update(True, 20) is None
    assert door.update(False, 30) is None
    assert door.update(False, 100) == "door_opened"


def test_door_inverted_covers_normally_closed_hardware():
    # Which kind you bought is not knowable from software.
    normal = DoorContact(debounce_ms=0, inverted=False)
    normal.update(True, 0)
    assert normal.update(False, 100) == "door_opened"

    inverted = DoorContact(debounce_ms=0, inverted=True)
    inverted.update(False, 0)
    assert inverted.update(True, 100) == "door_opened"


def test_door_emits_nothing_while_the_state_is_unchanged():
    door = DoorContact(debounce_ms=50)
    door.update(True, 0)

    for tick in range(1, 20):
        assert door.update(True, tick * 100) is None


# ------------------------------------------------------------------- hub client


class FakeStorage:
    def __init__(self, initial=None):
        self.data = dict(initial or {})

    def read(self, name):
        return self.data.get(name)

    def write(self, name, value):
        self.data[name] = value

    def remove(self, name):
        self.data.pop(name, None)


def make_client(responses, storage=None):
    """`responses` is a list of (status, body) returned in order."""
    calls = []

    def request(method, url, headers, body):
        calls.append({"method": method, "url": url, "headers": headers, "body": body})
        return responses[min(len(calls) - 1, len(responses) - 1)]

    client = HubClient("http://hub:8080/api", request, storage=storage or FakeStorage())
    return client, calls


def test_register_stores_the_issued_token():
    storage = FakeStorage()
    client, calls = make_client(
        [(200, {"enrollment": {"token": "ag_issued", "rotated": False}})], storage
    )

    assert client.register("esp32-door", "door", "Front Door", "boot-key") is True
    assert client.token == "ag_issued"
    assert storage.data["token.txt"] == "ag_issued"
    assert calls[0]["headers"]["Authorization"] == "Bearer boot-key"


def test_a_stored_token_is_reused_instead_of_re_enrolling():
    # Enrolment mints a NEW token every time and the hub counts rotations as
    # security-relevant. A board that re-enrolled on every reset would fill the audit
    # trail with rotations and teach whoever reads it to ignore them.
    storage = FakeStorage({"token.txt": "ag_existing"})
    client, calls = make_client([(200, {})], storage)

    assert client.ensure_registered("esp32-door", "door", "Front Door", "boot-key") is True
    assert client.token == "ag_existing"
    assert calls == []


def test_events_carry_the_issued_token_not_the_bootstrap_key():
    storage = FakeStorage({"token.txt": "ag_existing"})
    client, calls = make_client([(201, None)], storage)
    client.load_token()

    client.send_event("esp32-door", EventType.DOOR_OPENED, "2026-08-18T01:23:45.000Z")

    assert calls[0]["headers"]["Authorization"] == "Bearer ag_existing"


@pytest.mark.parametrize("status", [401, 404])
def test_a_rejected_credential_is_forgotten_so_the_board_re_enrols(status):
    # The usual cause is a wiped database or a deleted agent. Without this the board
    # retries with a dead token forever.
    storage = FakeStorage({"token.txt": "ag_stale"})
    client, _ = make_client([(status, None)], storage)
    client.load_token()

    client.heartbeat("esp32-door")

    assert client.token is None
    assert "token.txt" not in storage.data


def test_a_server_error_does_NOT_discard_the_token():
    # A 500 means the hub is unwell, not that the credential is wrong. Throwing the token
    # away would turn a transient outage into an unnecessary rotation.
    storage = FakeStorage({"token.txt": "ag_good"})
    client, _ = make_client([(500, None)], storage)
    client.load_token()

    client.send_event("esp32-door", EventType.DOOR_OPENED, "2026-08-18T01:23:45.000Z")

    assert client.token == "ag_good"


def test_frames_are_posted_as_raw_jpeg_not_json():
    storage = FakeStorage({"token.txt": "ag_cam"})
    client, calls = make_client([(201, None)], storage)
    client.load_token()

    client.send_frame("esp32-cam", b"\xff\xd8jpegbytes\xff\xd9")

    assert calls[0]["headers"]["Content-Type"] == "image/jpeg"
    assert isinstance(calls[0]["body"], bytes)


# ---------------------------------------------------------------------- backoff


def test_backoff_doubles_and_then_caps():
    # Unbounded doubling means a board that lost the hub for an hour takes another hour to
    # notice it return.
    assert [next_backoff_ms(n) for n in (1, 2, 3, 4)] == [1000, 2000, 4000, 8000]
    assert next_backoff_ms(20) == 30_000


def test_backoff_jitters_across_the_top_half_of_the_window():
    # A power cut takes every sensor down together; without jitter they all come back in
    # lockstep and hammer the hub at the worst possible moment.
    assert next_backoff_ms(3, lambda: 0.0) == 2000
    assert next_backoff_ms(3, lambda: 1.0) == 4000


# ------------------------------------------------------------------------ queue


def test_queue_drops_the_OLDEST_when_full():
    # Recent events are the ones an operator can still act on; older ones have been
    # overtaken. Dropping the newest would discard exactly the useful half.
    queue = EventQueue(limit=3)
    for n in range(5):
        queue.add(n)

    assert len(queue) == 3
    assert queue.peek() == 2
    assert queue.dropped == 2


def test_queue_preserves_order():
    queue = EventQueue(limit=5)
    queue.add("a")
    queue.add("b")

    assert queue.pop() == "a"
    assert queue.pop() == "b"
    assert queue.pop() is None
