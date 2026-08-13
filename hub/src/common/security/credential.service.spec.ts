import { AuthRole } from '@cpe310/contracts';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import { CredentialService } from './credential.service';
import { hashToken, mintAgentToken } from './tokens';

const BOOTSTRAP = 'a-real-bootstrap-secret';
const OPERATOR = 'a-real-operator-secret';

async function buildService(agentForHash: { id: string } | null = null) {
  const prisma = {
    agent: { findUnique: jest.fn().mockResolvedValue(agentForHash) },
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'auth.bootstrapKey') return BOOTSTRAP;
      if (key === 'auth.operatorKey') return OPERATOR;
      return undefined;
    }),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      CredentialService,
      { provide: PrismaService, useValue: prisma },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();

  return { service: moduleRef.get(CredentialService), prisma };
}

describe('CredentialService.resolve', () => {
  it('recognises the operator key', async () => {
    const { service } = await buildService();

    await expect(service.resolve(OPERATOR)).resolves.toEqual({ role: AuthRole.Operator });
  });

  it('recognises the bootstrap key', async () => {
    const { service } = await buildService();

    await expect(service.resolve(BOOTSTRAP)).resolves.toEqual({ role: AuthRole.Bootstrap });
  });

  it('resolves a valid agent token to its owning agent', async () => {
    const { token } = mintAgentToken();
    const { service, prisma } = await buildService({ id: 'motion-hallway' });

    await expect(service.resolve(token)).resolves.toEqual({
      role: AuthRole.Agent,
      agentId: 'motion-hallway',
    });
    // Looked up by hash, never by plaintext — the hub stores no plaintext to match.
    expect(prisma.agent.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashToken(token) },
      select: { id: true },
    });
  });

  it('returns null for a token-shaped string that no agent owns', async () => {
    const { service } = await buildService(null);

    await expect(service.resolve('ag_not-a-real-token')).resolves.toBeNull();
  });

  it('does not hit the database for a credential that is not token-shaped', async () => {
    // Otherwise every bad guess costs a query, which is a cheap amplification.
    const { service, prisma } = await buildService();

    await expect(service.resolve('totally-wrong')).resolves.toBeNull();
    expect(prisma.agent.findUnique).not.toHaveBeenCalled();
  });

  it('returns null for an empty credential', async () => {
    const { service, prisma } = await buildService();

    await expect(service.resolve('')).resolves.toBeNull();
    expect(prisma.agent.findUnique).not.toHaveBeenCalled();
  });

  it('does not treat a near-miss of the operator key as valid', async () => {
    const { service } = await buildService();

    await expect(service.resolve(OPERATOR.toUpperCase())).resolves.toBeNull();
  });
});
