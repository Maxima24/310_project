"""Sensor state machines, with no hardware in them.

Reading a pin is one line; deciding what the reading MEANS is where the bugs are, so that
part lives here where it can be tested against a list of numbers instead of a doorway.
Both classes take raw booleans and a monotonic millisecond clock, exactly as the caller
gets them from `machine.Pin` and `time.ticks_ms`.

Mirrors the semantics of the CPython agents in `agents/security_agent/` so a board and a
Pi produce the same event stream from the same physical situation — the hub cannot tell
them apart and should not have to.
"""


class MotionDetector:
    """PIR motion, rate-limited.

    A PIR holds its output high for its own dwell time — on an HC-SR501 that is a trimmer
    setting, commonly several seconds — so a naive "high means an event" produces a burst
    per person. Only the RISING edge counts, and then not again until the cooldown has
    passed, which is what stops one person walking down a corridor becoming forty alerts.
    """

    def __init__(self, cooldown_ms=10_000):
        self.cooldown_ms = cooldown_ms
        self._was_high = False
        self._last_fired = None

    def update(self, is_high, now_ms):
        """Returns True when this reading should raise a motion event."""
        rising = is_high and not self._was_high
        self._was_high = is_high

        if not rising:
            return False

        if self._last_fired is not None and _elapsed(self._last_fired, now_ms) < self.cooldown_ms:
            return False

        self._last_fired = now_ms
        return True

    @property
    def settling(self):
        """True until the first reading has been seen.

        An HC-SR501 needs roughly 30 seconds after power-up before its output means
        anything, and fires spuriously before then. `main` holds events back during that
        window — otherwise every boot reports an intruder, which is precisely the way to
        teach an operator to ignore the alert.
        """
        return self._last_fired is None


class DoorContact:
    """Magnetic reed switch, debounced and edge-triggered.

    Reports only CHANGES, because the hub's event model is about transitions: a door that
    is open is not news, a door that just opened is. Debounced because a reed switch
    chatters on the way past the magnet and would otherwise report a dozen open/close
    pairs for one push.

    `inverted` covers normally-open versus normally-closed hardware, the same escape the
    CPython agent has — which of the two you bought is not knowable from here.
    """

    def __init__(self, debounce_ms=50, inverted=False):
        self.debounce_ms = debounce_ms
        self.inverted = inverted
        self._stable = None
        self._candidate = None
        self._changed_at = None

    def update(self, circuit_closed, now_ms):
        """Returns 'door_opened', 'door_closed', or None."""
        # With an internal pull-up, a closed circuit reads LOW. The caller passes what the
        # circuit is doing; this decides what the door is doing.
        is_open = circuit_closed if self.inverted else not circuit_closed

        if self._stable is None:
            # First reading establishes the baseline WITHOUT emitting. A door that was
            # already shut at boot has not just shut. The candidate is seeded here too:
            # leaving it None made the first real transition merely *start* the debounce
            # and return, so every device swallowed its first event after boot.
            self._stable = is_open
            self._candidate = is_open
            self._changed_at = now_ms
            return None

        if is_open != self._candidate:
            self._candidate = is_open
            self._changed_at = now_ms

        # Settled back to where it started — the bounce never became a real transition.
        if self._candidate == self._stable:
            return None

        if _elapsed(self._changed_at, now_ms) < self.debounce_ms:
            return None

        self._stable = self._candidate
        return "door_opened" if self._stable else "door_closed"


def _elapsed(since_ms, now_ms):
    """Milliseconds between two `ticks_ms` readings, tolerating wraparound.

    MicroPython's `ticks_ms` wraps at a platform-defined ceiling — around 12.4 days on
    ESP32 — and a plain subtraction across the wrap gives a huge negative number. A
    cooldown comparing against that would never fire again, so a board left running for a
    fortnight would silently stop reporting motion. Masking to 30 bits reproduces
    `ticks_diff` semantics without importing `time`, keeping this module pure.
    """
    return (now_ms - since_ms) & 0x3FFFFFFF
