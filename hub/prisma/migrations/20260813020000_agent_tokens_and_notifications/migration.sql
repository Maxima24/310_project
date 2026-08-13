-- Roadmap item 2 (per-agent credentials) and item 3 (notification fan-out).
--
-- Additive and non-destructive: the token columns are nullable, so existing agents
-- keep their rows and simply hold no token until they next enroll.

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('email', 'webhook', 'log');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('sent', 'failed', 'pending', 'skipped');

-- AlterTable
-- Only the SHA-256 hash of a token is stored, so a database dump yields no working
-- credentials. tokenRotations records re-enrollments, which are legitimate but are
-- also what a holder of the bootstrap key would cause.
ALTER TABLE "Agent" ADD COLUMN     "tokenHash" TEXT,
ADD COLUMN     "tokenIssuedAt" TIMESTAMP(3),
ADD COLUMN     "tokenRotations" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Drives the retry sweep.
CREATE INDEX "Notification_status_nextAttemptAt_idx" ON "Notification"("status", "nextAttemptAt");

-- CreateIndex
-- One row per (alert, channel) makes delivery idempotent if a retry races a
-- fresh dispatch.
CREATE UNIQUE INDEX "Notification_alertId_channel_key" ON "Notification"("alertId", "channel");

-- CreateIndex
-- The lookup key on every authenticated agent request, so it must be indexed.
CREATE UNIQUE INDEX "Agent_tokenHash_key" ON "Agent"("tokenHash");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
