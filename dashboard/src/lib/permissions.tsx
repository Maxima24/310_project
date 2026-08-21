import {
  AuthRole,
  Permission,
  SystemMode,
  type AlertView,
  type IdentityResponse,
  type PolicyDecision,
} from '@cpe310/contracts';
import { createContext, useContext, type ReactNode } from 'react';

/**
 * Authorization in the UI.
 *
 * Two things this file is careful about:
 *
 * 1. **The permission list comes from the hub** (`GET /auth/me`), never from a role
 *    table compiled into the bundle. A policy change on the server therefore takes
 *    effect here without a redeploy, and the two cannot drift.
 *
 * 2. **This is presentation, not security.** Hiding a button stops an accident, not an
 *    attacker — anyone holding the credential can call the API directly. Every rule
 *    mirrored here is independently enforced by the hub's guard and PolicyService, and
 *    the UI's job is to avoid offering actions that would be refused.
 */

interface AuthContextValue {
  identity: IdentityResponse;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  identity,
  children,
}: {
  identity: IdentityResponse;
  children: ReactNode;
}) {
  return <AuthContext.Provider value={{ identity }}>{children}</AuthContext.Provider>;
}

export function useIdentityContext(): IdentityResponse {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useIdentityContext must be used inside <AuthProvider>');
  return context.identity;
}

/** RBAC: does this credential hold a permission? */
export function useCan(permission: Permission): boolean {
  const identity = useIdentityContext();
  return identity.permissions.includes(permission);
}

/** Convenience for the common reads. */
export function usePermissions() {
  const identity = useIdentityContext();
  const has = (permission: Permission) => identity.permissions.includes(permission);

  return {
    identity,
    role: identity.role,
    zones: identity.zones,
    /** True when this credential sees only part of the building. */
    isZoneRestricted: identity.zones.length > 0,
    canReadAgents: has(Permission.AgentsRead),
    canReadEvents: has(Permission.EventsRead),
    canReadAlerts: has(Permission.AlertsRead),
    canAcknowledge: has(Permission.AlertsAck),
    canArm: has(Permission.SystemArm),
    canDisarm: has(Permission.SystemDisarm),
    canReadNotifications: has(Permission.NotificationsRead),
    // Knowing a camera exists and being allowed to look through it are different
    // things, and the hub enforces the second. The live view used to gate itself on
    // AgentsRead, so it would have offered a picture the API refuses the moment either
    // permission set is edited.
    canViewCameras: has(Permission.CamerasView),
    /** Minting a publishing credential for a browser. Admin only — see the permission. */
    canProvisionCameras: has(Permission.CamerasProvision),
    canReadAudit: has(Permission.AuditRead),
    canReadSchedules: has(Permission.SchedulesRead),
    canWriteSchedules: has(Permission.SchedulesWrite),
  };
}

/**
 * Renders `children` only when the credential holds the permission.
 *
 * `fallback` exists because silently omitting a control can be worse than showing it
 * disabled — an operator who cannot find the disarm button may assume the dashboard is
 * broken rather than that they lack the right.
 */
export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return useCan(permission) ? <>{children}</> : <>{fallback}</>;
}

/**
 * ABAC, client side: mirrors the hub's mode policy so the UI can explain a refusal
 * *before* the request instead of surfacing a 403 afterwards.
 *
 * The hub remains authoritative — it re-evaluates this with the real alert state on
 * every request. Duplicating the reasoning here is a UX affordance, and the wording is
 * kept close to the server's so the two do not read like different rules.
 */
export function evaluateModeChange(
  identity: IdentityResponse,
  target: SystemMode,
  alerts: AlertView[],
): PolicyDecision {
  const has = (permission: Permission) => identity.permissions.includes(permission);

  if (target === SystemMode.Disarmed) {
    if (!has(Permission.SystemDisarm)) {
      return {
        allowed: false,
        reason: 'This credential cannot disarm the system.',
        requiresRole: AuthRole.Operator,
      };
    }

    if (identity.role !== AuthRole.Admin) {
      const open = alerts.filter((a) => a.severity === 'critical' && !a.acknowledged).length;
      if (open > 0) {
        return {
          allowed: false,
          reason:
            `${open} critical alert${open === 1 ? '' : 's'} still unacknowledged. ` +
            'Acknowledge them first, or ask an admin to override — disarming now would ' +
            'silence an active incident.',
          requiresRole: AuthRole.Admin,
        };
      }
    }

    return { allowed: true };
  }

  if (!has(Permission.SystemArm)) {
    return {
      allowed: false,
      reason: 'This credential cannot arm the system.',
      requiresRole: AuthRole.Operator,
    };
  }

  return { allowed: true };
}

/**
 * ABAC, client side: may this credential acknowledge this particular alert?
 *
 * Zone-restricted callers may only clear alerts from their own zones. The dashboard
 * cannot always tell — `AlertView` carries `agentId`, not a location — so this takes the
 * resolved location from the agent list and errs toward *allowing* the attempt when it
 * cannot tell, letting the hub be the one to refuse. Better a rare 403 with a real
 * explanation than a button hidden for the wrong reason.
 */
export function canAcknowledgeAlert(
  identity: IdentityResponse,
  alert: AlertView,
  locationOf: (agentId: string) => string | undefined,
): PolicyDecision {
  if (!identity.permissions.includes(Permission.AlertsAck)) {
    return {
      allowed: false,
      reason: 'This credential cannot acknowledge alerts.',
      requiresRole: AuthRole.Operator,
    };
  }

  if (identity.zones.length === 0) return { allowed: true };

  const location = alert.agentId ? locationOf(alert.agentId) : undefined;
  if (!location) return { allowed: true };

  const inZone = identity.zones.some((zone) => zone.toLowerCase() === location.toLowerCase());
  return inZone
    ? { allowed: true }
    : { allowed: false, reason: `Outside your zones (${identity.zones.join(', ')}).` };
}
