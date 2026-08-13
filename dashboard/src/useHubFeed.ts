import {
  WS_AGENT,
  WS_ALERT,
  WS_EVENT,
  WS_MODE,
  type AgentView,
  type AlertView,
  type EventView,
  type SystemModeResponse,
} from '@cpe310/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import { api, getOperatorKey } from './api';

/** Cap on retained events so a long session cannot grow without bound. */
const MAX_EVENTS = 120;
const MAX_ALERTS = 60;

export type ConnectionState = 'connecting' | 'live' | 'rejected' | 'offline';

export interface HubFeed {
  agents: AgentView[];
  events: EventView[];
  alerts: AlertView[];
  mode: SystemModeResponse | null;
  connection: ConnectionState;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Loads current state over REST, then keeps it current over WebSocket.
 *
 * Both halves are needed: the socket only carries what happens *after* connecting, so
 * without the initial fetch a freshly opened dashboard would show an empty building.
 * The channel names come from @cpe310/contracts, so a rename on the hub is a
 * compile error here rather than a silently dead panel.
 */
export function useHubFeed(authorised: boolean): HubFeed {
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [events, setEvents] = useState<EventView[]>([]);
  const [alerts, setAlerts] = useState<AlertView[]>([]);
  const [mode, setMode] = useState<SystemModeResponse | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextAgents, nextEvents, nextAlerts, nextMode] = await Promise.all([
        api.agents(),
        api.events(MAX_EVENTS),
        api.alerts(MAX_ALERTS),
        api.mode(),
      ]);
      setAgents(nextAgents);
      setEvents(nextEvents);
      setAlerts(nextAlerts);
      setMode(nextMode);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!authorised) return;
    void refresh();
  }, [authorised, refresh]);

  useEffect(() => {
    if (!authorised) return;

    const socket = io('/', {
      // The shape the gateway checks; it requires an operator credential.
      auth: { key: getOperatorKey() },
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnection('live'));

    socket.on('disconnect', (reason) => {
      // The gateway calls disconnect(true) on a bad credential, which surfaces as a
      // server-side disconnect rather than a connect_error.
      setConnection(reason === 'io server disconnect' ? 'rejected' : 'offline');
    });

    socket.on('connect_error', () => setConnection('offline'));

    socket.on(WS_EVENT, (event: EventView) => {
      setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
    });

    socket.on(WS_ALERT, (alert: AlertView) => {
      setAlerts((prev) => {
        // Alerts arrive again when acknowledged, so replace rather than prepend or the
        // list would show the same alert twice with conflicting state.
        const without = prev.filter((a) => a.id !== alert.id);
        return [alert, ...without].slice(0, MAX_ALERTS);
      });
    });

    socket.on(WS_MODE, (next: SystemModeResponse) => setMode(next));

    socket.on(WS_AGENT, (agent: AgentView) => {
      setAgents((prev) => {
        const index = prev.findIndex((a) => a.id === agent.id);
        if (index === -1) return [...prev, agent];
        const copy = [...prev];
        copy[index] = agent;
        return copy;
      });
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [authorised]);

  // secondsSinceLastSeen is computed by the hub at request time, so it would freeze
  // between pushes. A slow poll keeps the "last seen" column honest without making the
  // WebSocket redundant.
  useEffect(() => {
    if (!authorised) return;
    const timer = setInterval(() => {
      void api
        .agents()
        .then(setAgents)
        .catch(() => undefined);
    }, 10_000);
    return () => clearInterval(timer);
  }, [authorised]);

  return { agents, events, alerts, mode, connection, error, refresh };
}
