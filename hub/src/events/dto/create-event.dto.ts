import { EventType } from '@cpe310/contracts';
import { IsIn, IsISO8601, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateEventDto {
  @IsString()
  @MaxLength(64)
  agentId: string;

  @IsIn(Object.values(EventType), {
    message: `type must be one of: ${Object.values(EventType).join(', ')}`,
  })
  type: EventType;

  /** Agent-side clock. The hub stamps its own receive time independently. */
  @IsISO8601({ strict: true }, { message: 'occurredAt must be an ISO 8601 timestamp' })
  occurredAt: string;

  /**
   * Free-form by design — this is the seam for a camera's contour area today and a
   * video clip reference later (roadmap item 5), with no migration needed.
   */
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
