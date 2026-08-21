import {
  MINUTES_PER_DAY,
  type ArmScheduleView,
  type UpsertArmScheduleRequest,
} from '@cpe310/contracts';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ArmSchedule } from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
import { isValidTimezone, localNow, seedLastFiredFor } from './local-time';

/** Guards against a paste that would make the list unreadable. */
const MAX_NAME_LENGTH = 80;

@Injectable()
export class SchedulesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<ArmScheduleView[]> {
    return this.prisma.armSchedule
      .findMany({ orderBy: [{ startMinute: 'asc' }, { name: 'asc' }] })
      .then((rows) => rows.map(toScheduleView));
  }

  async create(input: UpsertArmScheduleRequest, now = new Date()): Promise<ArmScheduleView> {
    const data = this.validate(input);

    const row = await this.prisma.armSchedule.create({
      data: {
        ...data,
        // See seedLastFiredFor: a schedule created after today's boundary must not
        // report that it missed a window it did not exist for.
        lastFiredFor: seedLastFiredFor(data.startMinute, localNow(now, data.timezone)),
      },
    });

    return toScheduleView(row);
  }

  async update(
    id: string,
    input: UpsertArmScheduleRequest,
    now = new Date(),
  ): Promise<ArmScheduleView> {
    const existing = await this.prisma.armSchedule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`No schedule ${id}`);

    const data = this.validate(input);
    const local = localNow(now, data.timezone);

    // Moving the boundary re-seeds it, for the same reason creation does — an edit that
    // sets the time to one already past today should take effect tomorrow, not fire
    // immediately and look like a bug.
    const movedBoundary =
      data.startMinute !== existing.startMinute || data.timezone !== existing.timezone;

    const row = await this.prisma.armSchedule.update({
      where: { id },
      data: {
        ...data,
        ...(movedBoundary
          ? { lastFiredFor: seedLastFiredFor(data.startMinute, local) }
          : {}),
      },
    });

    return toScheduleView(row);
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.prisma.armSchedule.deleteMany({ where: { id } });
    if (deleted.count === 0) throw new NotFoundException(`No schedule ${id}`);
  }

  /**
   * Rejects anything the evaluator could not act on later.
   *
   * Validated here rather than only in the DTO because the timezone check needs the
   * platform's tz database — a syntactically fine string like "America/Metropolis" would
   * pass a regex and then throw at 03:00 inside a cron job, which is the worst possible
   * place to discover it.
   */
  private validate(input: UpsertArmScheduleRequest) {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('A schedule needs a name.');
    if (name.length > MAX_NAME_LENGTH) {
      throw new BadRequestException(`Name must be ${MAX_NAME_LENGTH} characters or fewer.`);
    }

    if (
      !Number.isInteger(input.startMinute) ||
      input.startMinute < 0 ||
      input.startMinute >= MINUTES_PER_DAY
    ) {
      throw new BadRequestException('startMinute must be between 0 and 1439.');
    }

    if (!isValidTimezone(input.timezone)) {
      throw new BadRequestException(
        `"${input.timezone}" is not a time zone this hub recognises. Use an IANA name ` +
          'such as "America/New_York".',
      );
    }

    const days = [...new Set(input.daysOfWeek ?? [])].sort((a, b) => a - b);
    if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new BadRequestException('daysOfWeek entries must be 0 (Sunday) through 6.');
    }

    return {
      name,
      mode: input.mode,
      startMinute: input.startMinute,
      timezone: input.timezone,
      daysOfWeek: days,
      enabled: input.enabled ?? true,
    };
  }
}

export function toScheduleView(row: ArmSchedule): ArmScheduleView {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    mode: row.mode,
    daysOfWeek: row.daysOfWeek,
    startMinute: row.startMinute,
    timezone: row.timezone,
    ...(row.lastFiredAt ? { lastFiredAt: row.lastFiredAt.toISOString() } : {}),
    ...(row.lastFiredFor ? { lastFiredFor: row.lastFiredFor } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
