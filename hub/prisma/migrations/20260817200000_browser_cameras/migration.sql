-- Browser cameras: a hub-set origin marker, an optional token expiry, and two audit
-- actions.
--
-- Purely additive. `origin` defaults to 'device', so every existing agent is already
-- correct and no backfill is needed; `tokenExpiresAt` is null for every existing token,
-- which means "never expires" and preserves current behaviour exactly.
--
-- The audit enum values are added in this migration but not written until the code that
-- ships with it. Postgres will not let a value added by ALTER TYPE be used in the same
-- transaction, so they must exist before the first insert that references them — which
-- is precisely why they land here rather than alongside their first use.

-- CreateEnum
CREATE TYPE "AgentOrigin" AS ENUM ('device', 'browser');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'browser_camera_provisioned';
ALTER TYPE "AuditAction" ADD VALUE 'browser_camera_revoked';

-- AlterTable
-- No index on `origin`: the fleet is a handful of rows, the existing
-- (status, lastSeenAt) index still serves the liveness sweep, and adding a leading
-- column for a filter over three rows would be premature.
ALTER TABLE "Agent" ADD COLUMN     "tokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "origin" "AgentOrigin" NOT NULL DEFAULT 'device';
