import {
  AuthRole,
  Permission,
  SystemMode,
  zoneAllows,
  type PolicyDecision,
} from '@cpe310/contracts';
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { Identity } from './credential.service';

/**
 * Attribute-based authorization (the ABAC half).
 *
 * Roles answer "what may this kind of user do?" — that is the permission set on the
 * identity, checked by the guard. Policies answer "may they do it *right now*, to
 * *this* thing?", which depends on state the guard cannot see: current alerts, the
 * agent's location, the transition being attempted.
 *
 * Kept separate from the guard for two reasons: these checks need database reads that
 * would be wasteful on every request, and the resulting decisions carry a reason the
 * UI shows to a human rather than a bare 403.
 */
@Injectable()
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * May this identity move the system to `target`?
   *
   * The interesting rule: **disarming while a critical alert is unacknowledged
   * requires an admin.** The failure mode it prevents is entirely realistic — an
   * intrusion alarm is going off, and the quickest way to make it stop is to disarm
   * the system rather than investigate. That silences the alarm and stops further
   * alerts, which is exactly what an intruder who reached the panel would do.
   *
   * Acknowledging first is the intended path: it records that a human saw the alert,
   * and then disarming is permitted.
   */
  async canSetMode(identity: Identity, target: SystemMode): Promise<PolicyDecision> {
    if (!identity.permissions.includes(Permission.SystemDisarm) && target === SystemMode.Disarmed) {
      return {
        allowed: false,
        reason: 'This credential cannot disarm the system.',
        requiresRole: AuthRole.Operator,
      };
    }

    if (!identity.permissions.includes(Permission.SystemArm) && target !== SystemMode.Disarmed) {
      return {
        allowed: false,
        reason: 'This credential cannot arm the system.',
        requiresRole: AuthRole.Operator,
      };
    }

    // Only disarming is restricted. Raising protection is always allowed for anyone
    // who may arm at all — refusing to let someone *increase* security during an
    // incident would be the wrong default.
    if (target !== SystemMode.Disarmed) return { allowed: true };

    if (identity.role === AuthRole.Admin) return { allowed: true };

    const open = await this.prisma.alert.count({
      where: { severity: 'critical', acknowledged: false },
    });

    if (open === 0) return { allowed: true };

    return {
      allowed: false,
      reason:
        `${open} critical alert${open === 1 ? '' : 's'} still unacknowledged. ` +
        'Acknowledge them first, or ask an admin to override — disarming now would ' +
        'silence an active incident.',
      requiresRole: AuthRole.Admin,
    };
  }

  /**
   * May this identity see or act on a resource belonging to `location`?
   *
   * Zone scoping is what makes two viewers with identical roles see different data.
   */
  canAccessLocation(identity: Identity, location: string): PolicyDecision {
    if (zoneAllows(identity.zones, location)) return { allowed: true };

    return {
      allowed: false,
      reason: `This credential is limited to: ${identity.zones.join(', ')}.`,
    };
  }

  /**
   * Locations to filter reads by, or null for unrestricted.
   *
   * Returned as a value the query layer applies, rather than having each service
   * reimplement the rule.
   */
  zoneFilter(identity: Identity): string[] | null {
    return identity.zones.length > 0 ? identity.zones : null;
  }

  /**
   * May this identity acknowledge a specific alert?
   *
   * Zone-restricted callers may only clear alerts from their own zones — otherwise a
   * viewer-turned-operator for one wing could silence the whole building.
   */
  async canAcknowledgeAlert(identity: Identity, alertId: string): Promise<PolicyDecision> {
    if (!identity.permissions.includes(Permission.AlertsAck)) {
      return {
        allowed: false,
        reason: 'This credential cannot acknowledge alerts.',
        requiresRole: AuthRole.Operator,
      };
    }

    const zones = this.zoneFilter(identity);
    if (!zones) return { allowed: true };

    const alert = await this.prisma.alert.findUnique({
      where: { id: alertId },
      select: { agent: { select: { location: true } } },
    });

    // A system-level alert with no agent has no location to scope by; only an
    // unrestricted caller may clear it.
    if (!alert?.agent) {
      return {
        allowed: false,
        reason: 'This alert is not scoped to your zones.',
      };
    }

    return this.canAccessLocation(identity, alert.agent.location);
  }
}
