-- CreateEnum
CREATE TYPE "SimulationJobStatus" AS ENUM ('queued', 'running', 'completed', 'failed');

-- CreateTable
CREATE TABLE "SimulationJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "SimulationJobStatus" NOT NULL DEFAULT 'queued',
    "params" JSONB NOT NULL,
    "pathCount" INTEGER NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "chunkSize" INTEGER NOT NULL,
    "seed" INTEGER NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SimulationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulationResult" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "yearlyStats" JSONB NOT NULL,
    "pathsCompleted" INTEGER NOT NULL,
    "totalComputeMs" INTEGER NOT NULL,
    "wallMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimulationResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SimulationJob_userId_createdAt_idx" ON "SimulationJob"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SimulationResult_jobId_key" ON "SimulationResult"("jobId");

-- AddForeignKey
ALTER TABLE "SimulationJob" ADD CONSTRAINT "SimulationJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimulationResult" ADD CONSTRAINT "SimulationResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "SimulationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
