"""Sensor readers: simulated for any machine, GPIO stubs for a Raspberry Pi.

Both variants satisfy the same ``SensorReader`` protocol, so the agent classes are
identical whether they are driving a simulation or real hardware — the only
difference is which reader ``run_agent.py`` constructs.
"""

from __future__ import annotations

import logging
import random
from typing import Protocol, runtime_checkable

log = logging.getLogger(__name__)


@runtime_checkable
class SensorReader(Protocol):
    """A binary sensor. ``True`` means 'active' (motion present / door open)."""

    def read(self) -> bool: ...

    def close(self) -> None: ...


class SimulatedMotionSensor:
    """Fires with a fixed probability per poll.

    Seedable so tests are deterministic; the default is unseeded so a demo fleet
    does not trip in lockstep.
    """

    def __init__(self, probability: float = 0.05, seed: int | None = None) -> None:
        if not 0.0 <= probability <= 1.0:
            raise ValueError("probability must be between 0 and 1")
        self._probability = probability
        self._random = random.Random(seed)

    def read(self) -> bool:
        return self._random.random() < self._probability

    def close(self) -> None:
        return None


class SimulatedDoorSensor:
    """Models a door that opens occasionally and stays open for a few polls.

    Deliberately stateful rather than independent coin flips: a door that flickers
    open/closed on every poll would generate a stream of edge events that no real
    door produces, and would make the door agent's edge detection look broken.
    """

    def __init__(
        self,
        open_probability: float = 0.04,
        hold_polls: int = 3,
        seed: int | None = None,
    ) -> None:
        self._open_probability = open_probability
        self._hold_polls = hold_polls
        self._random = random.Random(seed)
        self._remaining_open = 0

    def read(self) -> bool:
        if self._remaining_open > 0:
            self._remaining_open -= 1
            return True
        if self._random.random() < self._open_probability:
            self._remaining_open = self._hold_polls - 1
            return True
        return False

    def close(self) -> None:
        return None


# ===========================================================================
# HARDWARE STUBS — Raspberry Pi
#
# Install gpiozero (see requirements-hardware.txt), then replace the bodies
# below with the commented lines. Nothing else in the codebase changes: the
# agents talk to the SensorReader protocol, not to these classes directly.
# ===========================================================================


class GpioMotionSensor:
    """PIR motion sensor on a GPIO pin.

    Wiring: PIR VCC -> 5V, GND -> GND, OUT -> the BCM pin passed as ``pin``.
    """

    def __init__(self, pin: int) -> None:
        self.pin = pin
        # ===== HARDWARE STUB: replace with gpiozero =====
        # from gpiozero import MotionSensor
        # self._device = MotionSensor(pin)
        raise NotImplementedError(
            f"GpioMotionSensor(pin={pin}) is a stub. Install gpiozero "
            "(pip install -r requirements-hardware.txt) and wire up the two "
            "commented lines in sensors.py — see the README 'Real hardware' section."
        )

    def read(self) -> bool:
        # ===== HARDWARE STUB =====
        # return bool(self._device.motion_detected)
        raise NotImplementedError

    def close(self) -> None:
        # ===== HARDWARE STUB =====
        # self._device.close()
        raise NotImplementedError


class GpioDoorSensor:
    """Magnetic reed switch on a GPIO pin.

    Wiring: reed switch between the BCM ``pin`` and GND, using gpiozero's internal
    pull-up. ``Button.is_pressed`` is True when the circuit is closed, so whether
    that means open or shut depends on whether the switch is normally-open or
    normally-closed — hence ``invert``.
    """

    def __init__(self, pin: int, invert: bool = False) -> None:
        self.pin = pin
        self.invert = invert
        # ===== HARDWARE STUB: replace with gpiozero =====
        # from gpiozero import Button
        # self._device = Button(pin, pull_up=True)
        raise NotImplementedError(
            f"GpioDoorSensor(pin={pin}) is a stub. Install gpiozero "
            "(pip install -r requirements-hardware.txt) and wire up the two "
            "commented lines in sensors.py — see the README 'Real hardware' section."
        )

    def read(self) -> bool:
        # ===== HARDWARE STUB =====
        # closed = bool(self._device.is_pressed)
        # return closed if self.invert else not closed
        raise NotImplementedError

    def close(self) -> None:
        # ===== HARDWARE STUB =====
        # self._device.close()
        raise NotImplementedError
