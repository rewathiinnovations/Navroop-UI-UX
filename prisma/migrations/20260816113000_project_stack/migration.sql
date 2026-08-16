-- CreateEnum
CREATE TYPE "Stack" AS ENUM ('NEXTJS', 'REACT', 'ASTRO', 'STATIC_HTML', 'VUE', 'SVELTE');

-- AlterTable
-- Existing rows stay REACT. New inserts also default to REACT.
ALTER TABLE "Project" ADD COLUMN "stack" "Stack" NOT NULL DEFAULT 'REACT';
