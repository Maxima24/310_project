"""Door collector."""

from __future__ import annotations

import logging

from ..base import BaseAgent
from ..contracts import AgentType, EventType, SensorEvent
from ..sensors import SensorReader
from ..transport import Transport

log = logging.getLogger(__name__)


class DoorAgent(BaseAgent):
    """Reports state *transitions* only — ``door_opened`` and ``door_closed``.

    Edge-triggered rather than level-triggered on purpose: a door left open for an
    hour is one event, not 3600. Reporting the level every poll would bury the
    moment the door actually moved, which is the only part anyone cares about, and
    the paired open/close events let the hub's event log show how long it stood open.
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
    ) -> None:
        super().__init__(
            agent_id,
            location,
            transport,
            poll_interval=poll_interval,
            heartbeat_interval=heartbeat_interval,
            capabilities=["door"],
        )
        self._sensor = sensor
        #: None until the first poll — see poll() for how the first reading is handled.
        self._was_open: bool | None = None

    @property
    def agent_type(self) -> AgentType:
        return AgentType.DOOR

    def poll(self) -> list[SensorEvent]:
        is_open = self._sensor.read()
        previous = self._was_open
        self._was_open = is_open

        if previous is None:
            # First reading establishes the baseline. A door found already open is
            # worth reporting; one found shut is not — otherwise every agent start
            # would emit a meaningless door_closed.
            return (
                [self.make_event(EventType.DOOR_OPENED, source="reed_switch", state="open", initial=True)]
                if is_open
                else []
            )

        if previous == is_open:
            return []

        event_type = EventType.DOOR_OPENED if is_open else EventType.DOOR_CLOSED
        return [self.make_event(event_type, source="reed_switch", state="open" if is_open else "closed")]

    def on_shutdown(self) -> None:
        self._sensor.close()
