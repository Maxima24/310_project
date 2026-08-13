import type { EventView } from '@cpe310/contracts';
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req } from '@nestjs/common';

import type { AuthenticatedRequest } from '../common/guards/auth.guard';
import { CanReadEvents, CanReportEvents } from '../common/guards/permissions.decorator';
import { CreateEventDto } from './dto/create-event.dto';
import { QueryEventsDto } from './dto/query-events.dto';
import { EventsService, type IngestResult } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /**
   * Returns the alert alongside the event so an agent can log locally whether its
   * report tripped anything, without polling `GET /alerts`.
   *
   * The guard enforces that `dto.agentId` equals the calling token's agent, so a
   * compromised sensor cannot inject a `door_closed` for the front door to mask an
   * intrusion elsewhere.
   */
  @Post()
  @CanReportEvents()
  @HttpCode(HttpStatus.CREATED)
  ingest(@Body() dto: CreateEventDto): Promise<IngestResult> {
    return this.events.ingest(dto);
  }

  /** Readable by viewers and above; zone-restricted callers see only their zones. */
  @Get()
  @CanReadEvents()
  findMany(
    @Query() query: QueryEventsDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<EventView[]> {
    return this.events.findMany(query, request.identity);
  }
}
