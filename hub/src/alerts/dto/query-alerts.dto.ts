import { AlertType } from '@cpe310/contracts';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class QueryAlertsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  /** `?acknowledged=false` is the "what still needs a human" query. */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  })
  @IsBoolean()
  acknowledged?: boolean;

  @IsOptional()
  @IsIn(Object.values(AlertType))
  type?: AlertType;

  @IsOptional()
  @IsString()
  agentId?: string;
}
