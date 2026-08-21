import { Permission, type ReportsSummary } from '@cpe310/contracts';
import { Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString } from 'class-validator';

import { RequirePermissions } from '../common/guards/permissions.decorator';
import { ReportsService } from './reports.service';

export class QueryReportsDto {
  /** Bounded: the query scans the window, so an arbitrary number is a slow query. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([7, 30, 90])
  days?: number;

  /** IANA zone for day boundaries. Falls back to UTC if the hub cannot resolve it. */
  @IsOptional()
  @IsString()
  tz?: string;
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /**
   * No permission of its own: a report is aggregated events and alerts, and anyone who
   * may read those may read a summary of them. Inventing `reports:read` would let the
   * two drift, so someone could be denied the total while allowed every row behind it.
   */
  @Get('summary')
  @RequirePermissions(Permission.EventsRead, Permission.AlertsRead)
  summary(@Query() query: QueryReportsDto): Promise<ReportsSummary> {
    return this.reports.summary(query.days ?? 30, query.tz ?? 'UTC');
  }
}
