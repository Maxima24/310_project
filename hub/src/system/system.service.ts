import type { SystemMode, SystemModeChangeResponse, SystemModeResponse } from '@cpe310/contracts';
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../common/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/** The singleton SystemState primary key. */
const STATE_ID = 1;

@Injectable()
export class SystemService {
  private readonly logger = new Logger(SystemService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Upserts rather than finds, so the hub works against a database that was
   * migrated but never seeded — the alert engine reads the mode on every event
   * and must never throw because a row is missing.
   */
  async getMode(): Promise<SystemModeResponse> {
    const state = await this.prisma.systemState.upsert({
      where: { id: STATE_ID },
      update: {},
      create: { id: STATE_ID },
    });

    return { mode: state.mode, updatedAt: state.updatedAt.toISOString() };
  }

  async setMode(mode: SystemMode): Promise<SystemModeChangeResponse> {
    const previous = await this.getMode();

    // A no-op POST should not bump updatedAt or re-broadcast; a dashboard
    // polling the arm button would otherwise flicker on every click.
    if (previous.mode === mode) {
      return { ...previous, previous: previous.mode, changed: false };
    }

    const state = await this.prisma.systemState.update({
      where: { id: STATE_ID },
      data: { mode },
    });

    const response: SystemModeResponse = {
      mode: state.mode,
      updatedAt: state.updatedAt.toISOString(),
    };

    this.logger.log(`System mode ${previous.mode} -> ${state.mode}`);
    this.realtime.emitMode(response);

    return { ...response, previous: previous.mode, changed: true };
  }
}
