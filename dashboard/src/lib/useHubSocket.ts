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
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';

import { useSessionStore } from '../stores/session.store';
import { CACHE_LIMITS, qk, upsertAlert } from './queries';

/**
 * Keeps the Query cache current from the hub's WebSocket feed.
 *
 * The socket writes into the SAME cache the REST queries populate rather than keeping
 * its own copy, so there is one source of truth per entity and a panel can never show
 * something that disagrees with a refetch.
 *
 * Both halves are needed: the socket only carries what happens *after* connecting, so
 * without the initial fetches a freshly opened dashboard would show an empty building.
 *
 * Channel names come from @cpe310/contracts, so a rename on the hub is a compile error
 * here rather than a silently dead panel.
 */
export function useHubSocket(credential: string, enabled: boolean): void {
  const queryClient = useQueryClient();
  const setConnection = useSessionStore((s) => s.setConnection);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!enabled || !credential) return;

    setConnection('connecting');

    const socket = io('/', {
      // The shape the gateway checks. It requires a credential holding alerts:read, so
      // an agent token is refused.
      auth: { key: credential },
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnection('live'));

    socket.on('disconnect', (reason) => {
      // The gateway calls disconnect(true) on an unauthorised credential, which
      // surfaces as a server-side disconnect rather than a connect_error — worth
      // distinguishing, because reconnecting will never help.
      setConnection(reason === 'io server disconnect' ? 'rejected' : 'offline');
    });

    socket.on('connect_error', () => setConnection('offline'));

    socket.on(WS_EVENT, (event: EventView) => {
      queryClient.setQueryData<EventView[]>(qk.events, (current) =>
        [event, ...(current ?? [])].slice(0, CACHE_LIMITS.MAX_EVENTS),
      );
    });

    socket.on(WS_ALERT, (alert: AlertView) => upsertAlert(queryClient, alert));

    socket.on(WS_MODE, (mode: SystemModeResponse) => {
      queryClient.setQueryData(qk.mode, mode);
    });

    socket.on(WS_AGENT, (agent: AgentView) => {
      queryClient.setQueryData<AgentView[]>(qk.agents, (current) => {
        const list = current ?? [];
        const index = list.findIndex((a) => a.id === agent.id);
        if (index === -1) return [...list, agent];
        const next = [...list];
        next[index] = agent;
        return next;
      });
    });

    return () => {
      socket.close();
      socketRef.current = null;
      setConnection('idle');
    };
  }, [credential, enabled, queryClient, setConnection]);
}
