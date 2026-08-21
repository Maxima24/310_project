-- The audit trail: who did what, and whether it was allowed.
--
-- Purely additive. No existing table is touched and no behaviour changes until the
-- call sites start recording, which they do from the same deploy.
--
-- Note what is NOT here: no column holds credential material, not even a hash. Agent
-- tokens are 256-bit random and safe to hash at rest, but the human credentials are
-- operator-chosen with an 8-character floor, and hashing one into this table would put
-- the first crackable copy of a secret into the database — to distinguish two holders
-- of the same shared key, which it could not do anyway.

-- CreateEnum
CREATE TYPE "AuditActor" AS ENUM ('bootstrap', 'agent', 'viewer', 'operator', 'admin', 'system');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('mode_changed', 'alert_acknowledged', 'agent_enrolled', 'agent_token_rotated', 'camera_viewed', 'schedule_fired');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('allowed', 'denied');

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" "AuditAction" NOT NULL,
    "outcome" "AuditOutcome" NOT NULL,
    "actor" "AuditActor" NOT NULL,
    "actorAgentId" TEXT,
    "actorLabel" TEXT,
    "reason" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_action_at_idx" ON "AuditLog"("action", "at" DESC);

-- CreateIndex
-- Serves the query that matters most: "what did the system refuse, most recent first".
CREATE INDEX "AuditLog_outcome_at_idx" ON "AuditLog"("outcome", "at" DESC);

-- No foreign key on actorAgentId, deliberately. The trail must outlive the agent it
-- describes: cascading a decommissioned sensor's enrollment history away would erase
-- exactly the record someone investigating that sensor came here to read.
