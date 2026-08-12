import { SystemMode } from '@cpe310/contracts';
import { IsIn } from 'class-validator';

export class SetModeDto {
  @IsIn(Object.values(SystemMode), {
    message: `mode must be one of: ${Object.values(SystemMode).join(', ')}`,
  })
  mode: SystemMode;
}
