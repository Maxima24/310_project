import { Global, Module } from '@nestjs/common';

import { PrismaModule } from '../common/prisma/prisma.module';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * Global because auditing cuts across every feature module — system, alerts, agents,
 * cameras, and the scheduler all record to it. The alternative is importing this
 * module into each of them, which makes it easy to add an auditable action and quietly
 * forget the audit.
 */
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
