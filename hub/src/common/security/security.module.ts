import { Global, Module } from '@nestjs/common';

import { CredentialService } from './credential.service';

/**
 * Global because credential resolution is needed by the HTTP guard, the WebSocket
 * gateway, and MQTT ingestion — three entry points that must agree on identity.
 */
@Global()
@Module({
  providers: [CredentialService],
  exports: [CredentialService],
})
export class SecurityModule {}
