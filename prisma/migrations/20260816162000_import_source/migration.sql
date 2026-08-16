-- CreateTable
CREATE TABLE "ImportSource" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "designTokens" JSONB NOT NULL,
    "sections" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImportSource_projectId_key" ON "ImportSource"("projectId");

-- AddForeignKey
ALTER TABLE "ImportSource" ADD CONSTRAINT "ImportSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
