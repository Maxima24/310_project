/**
 * Wire contracts shared between the hub and its clients.
 *
 * This package is the SOURCE OF TRUTH for the wire format. The Python agents
 * mirror it by hand in `agents/security_agent/contracts.py` — if you change a
 * string value here, change it there too. Both test suites assert against
 * literal wire strings, so a drift surfaces as a test failure rather than a
 * silent 400 in production.
 */
export * from './agent';
export * from './alert';
export * from './event';
export * from './mode';
export * from './ws';
