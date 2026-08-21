import { AuditAction, AuditActor, AuditOutcome } from '@cpe310/contracts';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

export class QueryAuditDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @IsIn(Object.values(AuditAction))
  action?: AuditAction;

  /** `?outcome=denied` is the question worth asking: what did the system refuse? */
  @IsOptional()
  @IsIn(Object.values(AuditOutcome))
  outcome?: AuditOutcome;

  @IsOptional()
  @IsIn(Object.values(AuditActor))
  actor?: AuditActor;

  @IsOptional()
  @IsISO8601()
  since?: string;
}
