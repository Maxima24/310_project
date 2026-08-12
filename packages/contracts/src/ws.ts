import type { AlertView } from './alert';
import type { EventView } from './event';
import type { SystemModeResponse } from './mode';
import type { AgentView } from './agent';

/**
 * WebSocket channel names. Exported as consts so the gateway and any client
 * cannot drift on a typo'd string literal.
 */
export const WS_EVENT = 'event' as const;
export const WS_ALERT = 'alert' as const;
export const WS_MODE = 'mode' as const;
/** Not in the original spec, but a dashboard needs to redraw an agent's status pill. */
export const WS_AGENT = 'agent' as const;

export const WS_CHANNELS = [WS_EVENT, WS_ALERT, WS_MODE, WS_AGENT] as const;

export type WsChannel = (typeof WS_CHANNELS)[number];

/** Payload carried by each channel. */
export interface WsPayloadMap {
  [WS_EVENT]: EventView;
  [WS_ALERT]: AlertView;
  [WS_MODE]: SystemModeResponse;
  [WS_AGENT]: AgentView;
}

/**
 * Handshake shape clients must send: `io(url, { auth: { key } })`.
 * Socket.io handshake auth bypasses Nest guards, so the gateway checks this itself.
 */
export interface WsHandshakeAuth {
  key: string;
}
