import { AuditActor, AuditAction, AuditOutcome, type AuditEntryView } from '@cpe310/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AuditTrail } from './AuditTrail';

const entries: AuditEntryView[] = [
  {
    id: 'e1',
    at: '2026-08-14T12:00:00.000Z',
    action: AuditAction.ModeChanged,
    outcome: AuditOutcome.Denied,
    actor: AuditActor.Operator,
    actorLabel: 'Ada Lovelace',
    reason: '1 critical alert still unacknowledged.',
    targetType: 'system',
    detail: {},
  },
];

vi.mock('../lib/queries', () => ({
  useAudit: () => ({ data: entries, isPending: false }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('AuditTrail', () => {
  it('renders the verified role as the actor', () => {
    render(<AuditTrail />, { wrapper });

    expect(screen.getByText('operator')).toBeInTheDocument();
  });

  it('marks a self-asserted name as a CLAIM, never as identity', () => {
    // The single most important thing this panel does. Credentials are shared per role,
    // so a name here is something the caller typed about themselves — presenting it the
    // same way as the verified role would turn decoration into false evidence.
    render(<AuditTrail />, { wrapper });

    const claim = screen.getByText(/Ada Lovelace/);
    expect(claim.textContent).toMatch(/claims/i);
    expect(claim).toHaveAttribute('title', expect.stringMatching(/cannot verify/i));
  });

  it('says up front that names are not checked', () => {
    render(<AuditTrail />, { wrapper });

    expect(screen.getByText(/names are self-asserted and not checked/i)).toBeInTheDocument();
  });

  it('shows a refusal as refused, with the reason the caller was given', () => {
    render(<AuditTrail />, { wrapper });

    expect(screen.getByText('refused')).toBeInTheDocument();
    expect(screen.getByText(/1 critical alert still unacknowledged/)).toBeInTheDocument();
  });

  it('offers a refusals-only filter, which is the question worth asking', () => {
    render(<AuditTrail />, { wrapper });

    expect(screen.getByLabelText('Filter by outcome')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Refused only' })).toBeInTheDocument();
  });
});
