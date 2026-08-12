import type { SystemModeChangeResponse, SystemModeResponse } from '@cpe310/contracts';
import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { SetModeDto } from './dto/set-mode.dto';
import { SystemService } from './system.service';

@Controller('system')
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @Get('mode')
  getMode(): Promise<SystemModeResponse> {
    return this.system.getMode();
  }

  @Post('mode')
  @HttpCode(HttpStatus.OK)
  setMode(@Body() dto: SetModeDto): Promise<SystemModeChangeResponse> {
    return this.system.setMode(dto.mode);
  }
}
