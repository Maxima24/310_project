import { AuthRole, ROLE_PERMISSIONS, type IdentityResponse } from '@cpe310/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { TopBar } from './TopBar';
import { AuthProvider } from '../lib/permissions';

function renderAs(role: AuthRole, path = '/') {
  const identity: IdentityResponse = {
    role,
    permissions: [...ROLE_PERMISSIONS[role]],
    zones: [],
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={client}>
      <AuthProvider identity={identity}>
        <MemoryRouter initialEntries={[path]}>
          <TopBar onRefresh={() => {}} />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function navLabels(): string[] {
  return screen
    .getAllByRole('link')
    .map((link) => link.getAttribute('title') ?? '')
    .filter(Boolean);
}

describe('TopBar navigation', () => {
  it('offers an operator every section', () => {
    renderAs(AuthRole.Operator);

    expect(navLabels()).toEqual(['Overview', 'Cameras', 'Reports', 'Settings']);
  });

  it('offers a viewer the same sections, since the pages gate themselves inside', () => {
    renderAs(AuthRole.Viewer);

    expect(navLabels()).toContain('Settings');
  });

  it('shows an agent token only the overview', () => {
    // The nav is built from the same table the route guard reads, so it cannot offer a
    // page the hub would refuse — a dead nav item invites the operator to keep trying.
    renderAs(AuthRole.Agent);

    expect(navLabels()).toEqual(['Overview']);
  });

  it('labels only the current section, to spend width on one thing', () => {
    renderAs(AuthRole.Operator, '/cameras');

    expect(screen.getByText('Cameras')).toBeInTheDocument();
    expect(screen.queryByText('Reports')).not.toBeInTheDocument();
  });

  it('marks the current section for assistive tech, not just visually', () => {
    renderAs(AuthRole.Operator, '/reports');

    const current = screen.getByRole('link', { current: 'page' });
    expect(current).toHaveAttribute('title', 'Reports');
  });

  it('shows the verified role even when no name was entered', () => {
    renderAs(AuthRole.Admin);

    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.getByText('Signed in')).toBeInTheDocument();
  });
});
