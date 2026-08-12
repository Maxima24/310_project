import type { EventView } from '@cpe310/contracts';
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';

import { CreateEventDto } from './dto/create-event.dto';
import { QueryEventsDto } from './dto/query-events.dto';
import { EventsService, type IngestResult } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /**
   * Returns the alert alongside the event so an agent can log locally whether its
   * report tripped anything, without polling `GET /alerts`.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  ingest(@Body() dto: CreateEventDto): Promise<IngestResult> {
    return this.events.ingest(dto);
  }

  @Get()
  findMany(@Query() query: QueryEventsDto): Promise<EventView[]> {
    return this.events.findMany(query);
  }
}
