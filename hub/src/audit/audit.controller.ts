import type { AuditEntryView } from '@cpe310/contracts';
import { Controller, Get, Query } from '@nestjs/common';

import { CanReadAudit } from '../common/guards/permissions.decorator';
import { AuditService } from './audit.service';
import { QueryAuditDto } from './dto/query-audit.dto';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /**
   * Admin-only. Newest first, which is how anyone reads an incident backwards.
   *
   * There is no write endpoint, and there will not be one. Every row here is produced
   * by the hub as a side effect of an action actually happening; a route that let a
   * caller append to the trail would make the whole table worthless.
   */
  @Get()
  @CanReadAudit()
  findMany(@Query() query: QueryAuditDto): Promise<AuditEntryView[]> {
    return this.audit.findMany(query);
  }
}
