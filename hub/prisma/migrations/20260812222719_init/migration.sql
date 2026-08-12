-- CreateEnum
CREATE TYPE "AgentType" AS ENUM ('motion', 'door', 'camera');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('online', 'offline');

-- CreateEnum
CREATE TYPE "SystemMode" AS ENUM ('disarmed', 'home', 'away');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('motion_detected', 'door_opened', 'door_closed', 'camera_motion');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('intrusion_motion', 'intrusion_door', 'camera_motion', 'agent_offline', 'agent_recovered');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('info', 'warning', 'critical');

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "type" "AgentType" NOT NULL,
    "location" TEXT NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'online',
    "version" TEXT,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "type" "EventType" NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "agentId" TEXT,
    "eventId" TEXT,
    "modeAtTrigger" "SystemMode" NOT NULL,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "mode" "SystemMode" NOT NULL DEFAULT 'disarmed',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Agent_status_lastSeenAt_idx" ON "Agent"("status", "lastSeenAt");

-- CreateIndex
CREATE INDEX "Event_createdAt_idx" ON "Event"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "Event_agentId_createdAt_idx" ON "Event"("agentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Event_type_createdAt_idx" ON "Event"("type", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Alert_createdAt_idx" ON "Alert"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "Alert_acknowledged_createdAt_idx" ON "Alert"("acknowledged", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Alert_type_agentId_acknowledged_createdAt_idx" ON "Alert"("type", "agentId", "acknowledged", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
