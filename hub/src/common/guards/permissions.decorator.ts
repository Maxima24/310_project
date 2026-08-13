import { Permission } from '@cpe310/contracts';
import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'cpe310:permissions';

/**
 * Declares the permissions a route requires (all of them, not any).
 *
 * Routes are guarded on permissions rather than roles so changing what a role may do
 * never means editing a controller — the mapping lives in one place, in the shared
 * contracts.
 *
 * A route with no decorator is denied to everyone except explicitly listed roles, so
 * forgetting the decorator fails closed. See AuthGuard.
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Enrollment. */
export const CanEnrollAgents = () => RequirePermissions(Permission.AgentsEnroll);

/** An agent reporting for itself. */
export const CanReportEvents = () => RequirePermissions(Permission.EventsWrite);
export const CanHeartbeat = () => RequirePermissions(Permission.AgentsHeartbeat);

/** Reads available to viewers and above. */
export const CanReadAgents = () => RequirePermissions(Permission.AgentsRead);
export const CanReadEvents = () => RequirePermissions(Permission.EventsRead);
export const CanReadAlerts = () => RequirePermissions(Permission.AlertsRead);
export const CanReadMode = () => RequirePermissions(Permission.SystemModeRead);

/** Operator actions. */
export const CanAcknowledge = () => RequirePermissions(Permission.AlertsAck);

/** Admin-only. */
export const CanReadNotifications = () => RequirePermissions(Permission.NotificationsRead);
