import { MINUTES_PER_DAY, SystemMode } from '@cpe310/contracts';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpsertScheduleDto {
  @IsString()
  @IsNotEmpty({ message: 'A schedule needs a name.' })
  @MaxLength(80)
  name: string;

  @IsIn(Object.values(SystemMode))
  mode: SystemMode;

  /** Minutes from local midnight. See ArmSchedule for why this is not "HH:MM". */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MINUTES_PER_DAY - 1)
  startMinute: number;

  /** IANA name. Checked against the platform's tz database in SchedulesService. */
  @IsString()
  @IsNotEmpty()
  timezone: string;

  /** 0 = Sunday. Omitted or empty means every day. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  daysOfWeek?: number[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
