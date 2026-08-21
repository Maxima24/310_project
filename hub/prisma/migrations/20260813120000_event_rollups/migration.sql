-- Hourly event rollups, written before raw events are pruned.
--
-- Purely additive: no existing row is touched, and with every retention window
-- defaulting to 0 (keep forever) applying this migration changes no behaviour on its
-- own. The table simply starts accumulating summaries on the next sweep.

-- CreateTable
CREATE TABLE "EventRollup" (
    "id" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "agentId" TEXT NOT NULL,
    "type" "EventType" NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "EventRollup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Serves every historical read, which is always "most recent first".
CREATE INDEX "EventRollup_hour_idx" ON "EventRollup"("hour" DESC);

-- CreateIndex
-- One row per bucket. This constraint is what makes the rollup writer idempotent:
-- ON CONFLICT ... DO UPDATE recounts a bucket rather than duplicating it, so a retried
-- or overlapping sweep cannot inflate history.
CREATE UNIQUE INDEX "EventRollup_hour_agentId_type_key" ON "EventRollup"("hour", "agentId", "type");

-- No foreign key to Agent, deliberately. A rollup outlives the raw events it counted
-- and should outlive a decommissioned agent too — cascading it away on agent deletion
-- would silently erase the activity history of exactly the sensor someone is asking
-- about. The agentId is kept as a label, not a reference.
