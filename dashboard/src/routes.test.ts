import { AuthRole, Permission, ROLE_PERMISSIONS } from '@cpe310/contracts';
import { describe, expect, it } from 'vitest';

import { ROUTES, mayAccess } from './routes';

const routeFor = (path: string) => ROUTES.find((route) => route.path === path)!;

describe('route access', () => {
  it('lets every signed-in credential reach the overview', () => {
    for (const role of Object.values(AuthRole)) {
      expect(mayAccess(routeFor('/'), ROLE_PERMISSIONS[role])).toBe(true);
    }
  });

  it('gives a viewer cameras, reports, and settings', () => {
    const viewer = ROLE_PERMISSIONS[AuthRole.Viewer];

    expect(mayAccess(routeFor('/cameras'), viewer)).toBe(true);
    expect(mayAccess(routeFor('/reports'), viewer)).toBe(true);
    // Read-only: the Settings page itself gates the panels inside it.
    expect(mayAccess(routeFor('/settings'), viewer)).toBe(true);
  });

  it('shows an agent token nothing beyond the overview', () => {
    // A sensor has no business enumerating cameras or reading schedules, and the nav is
    // built from this same list, so it cannot offer a page the hub would refuse.
    const agent = ROLE_PERMISSIONS[AuthRole.Agent];

    for (const path of ['/cameras', '/reports', '/settings']) {
      expect(mayAccess(routeFor(path), agent)).toBe(false);
    }
  });

  it('requires ALL listed permissions, not any of them', () => {
    // Reports aggregates events and alerts; holding one half must not open it.
    expect(mayAccess(routeFor('/reports'), [Permission.EventsRead])).toBe(false);
    expect(mayAccess(routeFor('/reports'), [Permission.EventsRead, Permission.AlertsRead])).toBe(
      true,
    );
  });

  it('declares a permission for every route except the overview', () => {
    // Guards against a page being added with no gate, which would fail open.
    for (const route of ROUTES) {
      if (route.path === '/') continue;
      expect(route.requires.length).toBeGreaterThan(0);
    }
  });

  it('has a unique path and label per route', () => {
    expect(new Set(ROUTES.map((r) => r.path)).size).toBe(ROUTES.length);
    expect(new Set(ROUTES.map((r) => r.label)).size).toBe(ROUTES.length);
  });
});
