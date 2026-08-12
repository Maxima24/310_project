import { AgentType } from '@cpe310/contracts';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterAgentDto {
  /**
   * Operator-chosen and used as the primary key, so it is constrained to
   * URL-safe characters — it appears in `/agents/:id/heartbeat`.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message: 'id may contain only letters, numbers, dot, underscore and hyphen',
  })
  id: string;

  @IsIn(Object.values(AgentType), {
    message: `type must be one of: ${Object.values(AgentType).join(', ')}`,
  })
  type: AgentType;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  location: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  version?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  capabilities?: string[];
}
