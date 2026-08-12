import { EventType } from '@cpe310/contracts';
import { Type } from 'class-transformer';
import { IsIn, IsISO8601, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class QueryEventsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  /** Returns events with `createdAt` strictly after this — for incremental polling. */
  @IsOptional()
  @IsISO8601({ strict: true })
  since?: string;

  @IsOptional()
  @IsString()
  agentId?: string;

  @IsOptional()
  @IsIn(Object.values(EventType))
  type?: EventType;
}
