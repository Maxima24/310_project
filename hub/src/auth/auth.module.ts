import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';

/**
 * CredentialService comes from the global SecurityModule, so this only needs to expose
 * the controller.
 */
@Module({
  controllers: [AuthController],
})
export class AuthModule {}
