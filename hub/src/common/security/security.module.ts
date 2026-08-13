import { Global, Module } from '@nestjs/common';

import { CredentialService } from './credential.service';
import { PolicyService } from './policy.service';

/**
 * Global because authorization is needed by the HTTP guard, the WebSocket gateway, MQTT
 * ingestion, and several controllers — all of which must agree on identity and policy.
 */
@Global()
@Module({
  providers: [CredentialService, PolicyService],
  exports: [CredentialService, PolicyService],
})
export class SecurityModule {}
