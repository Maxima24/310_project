"""Motion collector."""

from __future__ import annotations

import logging

from ..base import BaseAgent
from ..contracts import AgentType, EventType, SensorEvent
from ..sensors import SensorReader
from ..transport import Transport

log = logging.getLogger(__name__)


class MotionAgent(BaseAgent):
    """Reports ``motion_detected`` on a rising edge, with a local cooldown.

    The cooldown is separate from — and complementary to — the hub's alert
    dedup: this one keeps a chattering PIR from flooding the network with events,
    while the hub's keeps a legitimately busy sensor from flooding a human with
    alerts. Both are needed, because the event log should still show sustained
    activity even when only one alert fires.
    """

    def __init__(
        self,
        agent_id: str,
        location: str,
        transport: Transport,
        sensor: SensorReader,
        *,
        poll_interval: float = 1.0,
        heartbeat_interval: float = 10.0,
        cooldown: float = 5.0,
    ) -> None:
        super().__init__(
            agent_id,
            location,
            transport,
            poll_interval=poll_interval,
            heartbeat_interval=heartbeat_interval,
            capabilities=["motion"],
        )
        self._sensor = sensor
        self._cooldown_polls = max(0, round(cooldown / poll_interval)) if poll_interval > 0 else 0
        self._polls_since_report = self._cooldown_polls

    @property
    def agent_type(self) -> AgentType:
        return AgentType.MOTION

    def poll(self) -> list[SensorEvent]:
        active = self._sensor.read()
        self._polls_since_report += 1

        # `<` not `<=`: after N polls the full cooldown has elapsed, so the Nth
        # poll is eligible again. `<=` would stretch a 5s cooldown to 6s.
        if not active or self._polls_since_report < self._cooldown_polls:
            return []

        self._polls_since_report = 0
        return [self.make_event(EventType.MOTION_DETECTED, source="pir")]

    def on_shutdown(self) -> None:
        self._sensor.close()
