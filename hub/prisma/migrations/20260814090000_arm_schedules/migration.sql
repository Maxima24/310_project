-- Scheduled arming.
--
-- Purely additive. No schedules exist until someone creates one, so applying this
-- changes nothing about how the system behaves.

-- CreateTable
CREATE TABLE "ArmSchedule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "mode" "SystemMode" NOT NULL,
    "daysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "startMinute" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    -- Local date (YYYY-MM-DD), not a UTC instant: "today's 07:00 arm" has to mean the
    -- same thing on the day the clocks change. A conditional update on this column is
    -- what stops an overlapping tick or a restart firing the same schedule twice.
    "lastFiredFor" TEXT,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArmSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArmSchedule_enabled_idx" ON "ArmSchedule"("enabled");
