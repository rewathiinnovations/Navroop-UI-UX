-- The Stack enum rebuild re-applied a DEFAULT to Template.stack that the
-- schema never declared, which shows up as drift. Templates always name their
-- stack explicitly, so the column keeps no default.
ALTER TABLE "Template" ALTER COLUMN "stack" DROP DEFAULT;
