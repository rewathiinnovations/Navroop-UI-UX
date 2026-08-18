-- Self-verification for error tracking and silent background jobs.

CREATE TABLE "ObservabilityCheck" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "detail" TEXT,
    "eventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObservabilityCheck_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ObservabilityCheck_kind_createdAt_idx" ON "ObservabilityCheck"("kind", "createdAt");

CREATE TABLE "CronRun" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "durationMs" INTEGER,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CronRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CronRun_name_createdAt_idx" ON "CronRun"("name", "createdAt");
