import { AuthRole } from '@cpe310/contracts';
import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'cpe310:roles';

/**
 * Declares which credential roles may call a route.
 *
 * There is no "any authenticated caller" option on purpose: with no decorator the
 * guard requires Operator, so a route added later is locked down by default rather
 * than silently reachable by a sensor's token.
 */
export const Roles = (...roles: AuthRole[]) => SetMetadata(ROLES_KEY, roles);

/** Enrollment only. */
export const BootstrapOnly = () => Roles(AuthRole.Bootstrap);

/** An agent acting on its own behalf. The guard also enforces that it *is* that agent. */
export const AgentOnly = () => Roles(AuthRole.Agent);

/** Humans and dashboards. */
export const OperatorOnly = () => Roles(AuthRole.Operator);
