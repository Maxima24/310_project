"""Python collector agents for the CPE 310 physical security system.

Agents own hardware I/O and know nothing about alert policy — they report facts
("motion_detected at 20:41") and the hub decides whether a fact deserves an alert.
That split is what lets the same motion event be ignored while disarmed and treated
as an intrusion while away, with no agent redeploy.
"""

from .base import AGENT_VERSION, BaseAgent
from .contracts import AgentDescriptor, AgentType, EventType, SensorEvent, SystemMode, iso_now
from .transport import HttpTransport, MqttTransport, Transport, TransportError

__all__ = [
    "AGENT_VERSION",
    "AgentDescriptor",
    "AgentType",
    "BaseAgent",
    "EventType",
    "HttpTransport",
    "MqttTransport",
    "SensorEvent",
    "SystemMode",
    "Transport",
    "TransportError",
    "iso_now",
]
