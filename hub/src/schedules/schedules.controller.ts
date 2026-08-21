import { Permission, type ArmScheduleView } from '@cpe310/contracts';
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';

import type { AuthenticatedRequest } from '../common/guards/auth.guard';
import { RequirePermissions } from '../common/guards/permissions.decorator';
import { PolicyService } from '../common/security/policy.service';
import { UpsertScheduleDto } from './dto/upsert-schedule.dto';
import { SchedulesService } from './schedules.service';

@Controller('schedules')
export class SchedulesController {
  constructor(
    private readonly schedules: SchedulesService,
    private readonly policy: PolicyService,
  ) {}

  /** Viewers included: knowing why the system will arm at 22:00 is part of reading it. */
  @Get()
  @RequirePermissions(Permission.SchedulesRead)
  findAll(): Promise<ArmScheduleView[]> {
    return this.schedules.findAll();
  }

  @Post()
  @RequirePermissions(Permission.SchedulesWrite)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: UpsertScheduleDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ArmScheduleView> {
    this.assertMayManage(dto, request);
    return this.schedules.create(dto);
  }

  @Put(':id')
  @RequirePermissions(Permission.SchedulesWrite)
  async update(
    @Param('id') id: string,
    @Body() dto: UpsertScheduleDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ArmScheduleView> {
    this.assertMayManage(dto, request);
    return this.schedules.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permission.SchedulesWrite)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): Promise<void> {
    return this.schedules.remove(id);
  }

  /**
   * The guard establishes that the caller may touch schedules at all. This adds the
   * attribute-based half: they must also hold the permission the schedule would
   * exercise, so a schedule cannot become a way to disarm on a timer without holding
   * disarm.
   */
  private assertMayManage(dto: UpsertScheduleDto, request: AuthenticatedRequest): void {
    const decision = this.policy.canManageSchedule(request.identity!, dto.mode);
    if (!decision.allowed) {
      throw new ForbiddenException({
        message: decision.reason,
        requiresRole: decision.requiresRole,
      });
    }
  }
}
