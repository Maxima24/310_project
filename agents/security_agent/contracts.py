"""Wire contracts, mirrored by hand from ``packages/contracts/src/*.ts``.

That TypeScript package is the SOURCE OF TRUTH. If a string value changes there,
change it here too — the hub validates every field with class-validator and will
reject a drifted payload with a 400.

The mirror is deliberate rather than generated: four small payload shapes do not
justify a JSON-Schema codegen step in the build graph, and both test suites assert
against literal wire strings so a drift fails a test instead of failing in the field.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any


class AgentType(StrEnum):
    """Mirrors contracts/src/agent.ts AgentType."""

    MOTION = "motion"
    DOOR = "door"
    CAMERA = "camera"


class EventType(StrEnum):
    """Mirrors contracts/src/event.ts EventType."""

    MOTION_DETECTED = "motion_detected"
    DOOR_OPENED = "door_opened"
    DOOR_CLOSED = "door_closed"
    CAMERA_MOTION = "camera_motion"


class SystemMode(StrEnum):
    """Mirrors contracts/src/mode.ts SystemMode. Agents never set this — the hub owns arm state."""

    DISARMED = "disarmed"
    HOME = "home"
    AWAY = "away"


def iso_now() -> str:
    """UTC timestamp in the format the hub's ``@IsISO8601({strict: true})`` accepts.

    Millisecond precision with a literal ``Z``: Python's default ``isoformat()``
    emits microseconds and a ``+00:00`` offset, which is harder to eyeball in logs
    and gains nothing here.
    """
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True, slots=True)
class AgentDescriptor:
    """Body of ``POST /agents/register``."""

    id: str
    type: AgentType
    location: str
    version: str | None = None
    capabilities: list[str] = field(default_factory=list)

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "type": str(self.type),
            "location": self.location,
        }
        # Omit rather than send null: the hub's DTO marks these @IsOptional, and
        # an explicit null fails @IsString.
        if self.version is not None:
            payload["version"] = self.version
        if self.capabilities:
            payload["capabilities"] = list(self.capabilities)
        return payload


@dataclass(frozen=True, slots=True)
class SensorEvent:
    """Body of ``POST /events``."""

    agent_id: str
    type: EventType
    occurred_at: str = field(default_factory=iso_now)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        # Note the camelCase keys — the hub's DTO is TypeScript.
        return {
            "agentId": self.agent_id,
            "type": str(self.type),
            "occurredAt": self.occurred_at,
            "metadata": dict(self.metadata),
        }
