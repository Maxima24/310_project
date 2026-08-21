import { Permission } from '@cpe310/contracts';

import type { IconName } from './components/ui';

/**
 * The route table, in one place.
 *
 * Each entry names the permission that gates it, so the nav and the route guard read
 * from the same source. A page reachable from a nav item the credential should not see
 * — or worse, a nav item that leads to a 403 — is what happens when those two lists
 * live apart.
 */
export interface RouteDef {
  path: string;
  label: string;
  icon: IconName;
  /** Every listed permission is required. */
  requires: Permission[];
}

export const ROUTES: RouteDef[] = [
  { path: '/', label: 'Overview', icon: 'home', requires: [] },
  { path: '/cameras', label: 'Cameras', icon: 'camera', requires: [Permission.CamerasView] },
  {
    path: '/reports',
    label: 'Reports',
    icon: 'chart',
    requires: [Permission.EventsRead, Permission.AlertsRead],
  },
  {
    path: '/settings',
    label: 'Settings',
    icon: 'settings',
    // Reading schedules is enough to open Settings; the panels inside gate themselves
    // further, so a viewer sees the schedule list read-only and no audit trail at all.
    requires: [Permission.SchedulesRead],
  },
];

export function mayAccess(route: RouteDef, permissions: readonly Permission[]): boolean {
  return route.requires.every((permission) => permissions.includes(permission));
}
