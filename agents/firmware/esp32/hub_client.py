"""Talks to the hub: enrolment, heartbeats, events, and camera frames.

The transport is INJECTED rather than imported. On the board it is `urequests`; in the
test suite it is a function that records calls. That one choice is what lets the enrolment
sequence, the token lifecycle, the retry ladder, and the offline queue all be exercised on
a laptop — the alternative being to discover a logic error by flashing a board and reading
a serial console.
"""

from contracts import event_payload, registration_payload

#: Where the issued token is kept between reboots.
TOKEN_FILE = "token.txt"

#: Retry ceiling, matching the dashboard's own backoff. Beyond this a device that has been
#: unreachable for an hour would otherwise take another hour to notice the hub returning.
MAX_BACKOFF_MS = 30_000


def next_backoff_ms(attempt, random_fn=None):
    """Exponential with full jitter over the top half of the window.

    Jittered because a power cut takes every sensor in a building down together, and they
    would otherwise come back in lockstep and hammer the hub at the exact moment it is
    least able to answer. Mirrors `nextBackoffMs` in the dashboard deliberately: two
    different reconnect rhythms in one system is a debugging problem nobody needs.
    """
    ceiling = min(MAX_BACKOFF_MS, 1000 * (2 ** max(0, attempt - 1)))
    if random_fn is None:
        return ceiling
    return int(ceiling * (0.5 + random_fn() * 0.5))


class HubClient:
    def __init__(self, base_url, request_fn, storage=None, logger=None):
        """`request_fn(method, url, headers, body) -> (status, parsed_json_or_None)`."""
        self.base = base_url.rstrip("/")
        self._request = request_fn
        self._storage = storage or _FileStorage()
        self._log = logger or (lambda message: None)
        self.token = None

    # ------------------------------------------------------------------ enrolment

    def load_token(self):
        """Reads a previously issued token from flash.

        Persisting it matters more than it looks. Enrolment MINTS A NEW TOKEN every time
        and the hub counts rotations, treating them as security-relevant — legitimate when
        a device loses its credential, and also exactly what someone holding the bootstrap
        key would cause. A board that re-enrolled on every reset would fill the audit trail
        with rotation entries and train whoever reads it to ignore the one that matters.
        """
        self.token = self._storage.read(TOKEN_FILE)
        return self.token

    def register(self, agent_id, agent_type, location, bootstrap_key, version=None,
                 capabilities=None):
        """Enrols and stores the issued token. Returns True on success."""
        status, body = self._request(
            "POST",
            self.base + "/agents/register",
            {"Content-Type": "application/json", "Authorization": "Bearer " + bootstrap_key},
            registration_payload(agent_id, agent_type, location, version, capabilities),
        )

        if status != 200 or not body:
            self._log("enrolment failed: %s" % status)
            return False

        enrollment = body.get("enrollment") or {}
        token = enrollment.get("token")
        if not token:
            self._log("enrolment returned no token")
            return False

        self.token = token
        self._storage.write(TOKEN_FILE, token)

        if enrollment.get("rotated"):
            self._log("token ROTATED — any previously issued token for this id is now dead")
        return True

    def ensure_registered(self, agent_id, agent_type, location, bootstrap_key, version=None,
                          capabilities=None):
        """Uses a stored token if there is one, otherwise enrols."""
        if self.load_token():
            return True
        return self.register(agent_id, agent_type, location, bootstrap_key, version, capabilities)

    def forget_token(self):
        """Drops the stored token so the next cycle re-enrols.

        Called when the hub rejects the credential — the usual cause being that the
        database was reset, or the agent was deleted. Without this the board would retry
        with a dead token forever.
        """
        self.token = None
        self._storage.remove(TOKEN_FILE)

    # -------------------------------------------------------------------- reporting

    def heartbeat(self, agent_id):
        status, _ = self._authed("POST", "/agents/%s/heartbeat" % agent_id, None)
        return status

    def send_event(self, agent_id, event_type, occurred_at, metadata=None):
        status, _ = self._authed(
            "POST", "/events", event_payload(agent_id, event_type, occurred_at, metadata)
        )
        return status

    def send_frame(self, agent_id, jpeg_bytes):
        """Publishes one camera frame.

        Raw bytes with an image content type, not JSON — the hub parses this route with a
        separate raw body parser, and base64 in a JSON envelope would inflate every frame
        by a third for nothing.
        """
        status, _ = self._request(
            "POST",
            self.base + "/cameras/%s/frame" % agent_id,
            {"Content-Type": "image/jpeg", "Authorization": "Bearer " + (self.token or "")},
            jpeg_bytes,
        )
        return status

    def _authed(self, method, path, body):
        headers = {"Authorization": "Bearer " + (self.token or "")}
        if body is not None:
            headers["Content-Type"] = "application/json"

        status, parsed = self._request(method, self.base + path, headers, body)

        # 401 means the credential is no longer recognised; 404 on a heartbeat means the
        # agent row is gone. Both are recoverable by enrolling again, and both are
        # permanent if we do not.
        if status in (401, 404):
            self._log("credential rejected (%s) — will re-enrol" % status)
            self.forget_token()

        return status, parsed


class EventQueue:
    """A bounded buffer for events raised while the hub is unreachable.

    Bounded on purpose, and it DROPS THE OLDEST when full. A board with 8 MB of flash and
    a Wi-Fi outage could otherwise queue for days and then flood the hub with ancient
    history the moment it returns. Recent events are what an operator can still act on;
    older ones have already been overtaken.
    """

    def __init__(self, limit=32):
        self.limit = limit
        self._items = []
        self.dropped = 0

    def add(self, item):
        if len(self._items) >= self.limit:
            self._items.pop(0)
            self.dropped += 1
        self._items.append(item)

    def peek(self):
        return self._items[0] if self._items else None

    def pop(self):
        return self._items.pop(0) if self._items else None

    def __len__(self):
        return len(self._items)


class _FileStorage:
    """Flash-backed strings. Split out so tests can hand in a dictionary instead."""

    def read(self, name):
        try:
            with open(name) as handle:
                value = handle.read().strip()
                return value or None
        except OSError:
            return None

    def write(self, name, value):
        with open(name, "w") as handle:
            handle.write(value)

    def remove(self, name):
        try:
            import os

            os.remove(name)
        except OSError:
            pass
