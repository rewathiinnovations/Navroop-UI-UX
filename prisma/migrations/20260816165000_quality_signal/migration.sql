-- AlterTable
ALTER TABLE "GenerationEvent" ADD COLUMN IF NOT EXISTS "promptVersion" TEXT;

-- CreateTable
CREATE TABLE "QualitySignal" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "generationEventId" TEXT,
    "kind" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "rawValue" JSONB,
    "promptVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QualitySignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QualitySignal_kind_createdAt_idx" ON "QualitySignal"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "QualitySignal_promptVersion_idx" ON "QualitySignal"("promptVersion");

-- CreateIndex
CREATE INDEX "QualitySignal_projectId_idx" ON "QualitySignal"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_hash_key" ON "PromptVersion"("hash");

-- CreateIndex
CREATE INDEX "PromptVersion_isActive_idx" ON "PromptVersion"("isActive");

-- AddForeignKey
ALTER TABLE "QualitySignal" ADD CONSTRAINT "QualitySignal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
