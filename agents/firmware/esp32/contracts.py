"""Wire contract, mirrored by hand for MicroPython.

THIS IS THE THIRD COPY of the same contract. `packages/contracts/src/*.ts` is the source
of truth, `agents/security_agent/contracts.py` mirrors it for CPython, and this mirrors it
again for a board that cannot import either. Change a string in one and change it in all
three — every suite asserts against literal wire strings so a drift surfaces as a test
failure rather than a silent 400 at three in the morning.

Deliberately free of any MicroPython import, so the payload building and timestamp
formatting below can be exercised by the normal pytest suite on a development machine.
That matters more here than usual: the alternative to testing this on a laptop is testing
it by flashing a board and reading a serial log.
"""


class EventType:
    MOTION_DETECTED = "motion_detected"
    DOOR_OPENED = "door_opened"
    DOOR_CLOSED = "door_closed"
    CAMERA_MOTION = "camera_motion"


class AgentType:
    MOTION = "motion"
    DOOR = "door"
    CAMERA = "camera"


def iso_timestamp(gm):
    """Formats a `time.gmtime()` tuple as strict ISO 8601 in UTC.

    Hand-rolled because MicroPython has no `datetime`, and the hub's DTO validates this
    field with `@IsISO8601({ strict: true })` — a malformed value is rejected outright,
    which presents as every single event failing with a validation error that says
    nothing about clocks.

    The board has no battery-backed clock, so `main` must NTP-sync before anything calls
    this. A device fresh from reset believes it is January 2000, and while the hub stamps
    its own arrival time and orders history by that, the field still has to parse.
    """
    year, month, day, hour, minute, second = gm[0], gm[1], gm[2], gm[3], gm[4], gm[5]
    return "%04d-%02d-%02dT%02d:%02d:%02d.000Z" % (year, month, day, hour, minute, second)


def registration_payload(agent_id, agent_type, location, version=None, capabilities=None):
    """Body for `POST /agents/register`.

    Optional fields are OMITTED rather than sent as null: the hub's DTO marks them
    `@IsOptional`, and an explicit null fails `@IsString`.
    """
    payload = {"id": agent_id, "type": agent_type, "location": location}
    if version is not None:
        payload["version"] = version
    if capabilities:
        payload["capabilities"] = list(capabilities)
    return payload


def event_payload(agent_id, event_type, occurred_at, metadata=None):
    """Body for `POST /events`. Note the camelCase keys — the hub is TypeScript."""
    return {
        "agentId": agent_id,
        "type": event_type,
        "occurredAt": occurred_at,
        "metadata": dict(metadata or {}),
    }
