#!/usr/bin/env node
/**
 * Minimal socket.io observer for the hub's live feed.
 *
 *   node tools/ws-client.mjs --key dev-key-change-me
 *   node tools/ws-client.mjs --url http://localhost:3000 --key dev-key-change-me
 *
 * Prints every `event`, `alert`, `mode`, and `agent` frame. Leave it running while
 * arming the system and tripping a sensor — it is the only way to verify the
 * WebSocket auth path, which the HTTP guard does not cover.
 *
 * Exit codes: 0 clean shutdown (Ctrl-C), 1 rejected/failed connection.
 */

import { io } from 'socket.io-client';

function parseArgs(argv) {
  const args = { url: process.env.HUB_URL ?? 'http://localhost:3000', key: process.env.AGENT_API_KEY ?? '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') args.url = argv[++i];
    else if (arg === '--key') args.key = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log('Usage: node tools/ws-client.mjs [--url http://localhost:3000] [--key <AGENT_API_KEY>]');
  process.exit(0);
}

if (!args.key) {
  console.error('No key. Pass --key <AGENT_API_KEY> or set AGENT_API_KEY.');
  console.error('  PowerShell: $env:AGENT_API_KEY = "dev-key-change-me"');
  process.exit(1);
}

const COLORS = { critical: '\x1b[31m', warning: '\x1b[33m', info: '\x1b[36m', reset: '\x1b[0m', dim: '\x1b[2m' };

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function line(channel, text, color = '') {
  console.log(`${COLORS.dim}${stamp()}${COLORS.reset} ${color}[${channel}]${COLORS.reset} ${text}`);
}

console.log(`Connecting to ${args.url} ...`);

const socket = io(args.url, {
  // The shape the gateway checks. A bad key here is disconnected at handshake.
  auth: { key: args.key },
  reconnection: true,
  reconnectionDelay: 1000,
  transports: ['websocket', 'polling'],
});

socket.on('connect', () => line('open', `connected as ${socket.id}`, COLORS.info));

socket.on('event', (e) => {
  const extra = Object.keys(e.metadata ?? {}).length ? ` ${JSON.stringify(e.metadata)}` : '';
  line('event', `${e.type} from ${e.agentId}${extra}`);
});

socket.on('alert', (a) => {
  const color = COLORS[a.severity] ?? '';
  const ack = a.acknowledged ? ' (acknowledged)' : '';
  line('alert', `${a.severity.toUpperCase()} ${a.type} — ${a.message}${ack}`, color);
});

socket.on('mode', (m) => line('mode', `system is now ${m.mode}`, COLORS.warning));

socket.on('agent', (a) => line('agent', `${a.id} is ${a.status} (last seen ${a.secondsSinceLastSeen}s ago)`));

socket.on('disconnect', (reason) => {
  line('close', `disconnected: ${reason}`, COLORS.warning);
  // The gateway calls disconnect(true) on a bad key, which surfaces here as a
  // server-side disconnect rather than a connect_error.
  if (reason === 'io server disconnect') {
    console.error('\nThe hub closed the connection. Usually a wrong --key.');
    process.exit(1);
  }
});

socket.on('connect_error', (err) => line('error', err.message, COLORS.critical));

process.on('SIGINT', () => {
  line('close', 'shutting down', COLORS.dim);
  socket.close();
  process.exit(0);
});
