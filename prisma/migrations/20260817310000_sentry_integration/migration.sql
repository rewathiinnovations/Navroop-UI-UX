-- Sentry moves from env vars to the Integration store + runtime config file.

ALTER TYPE "IntegrationKind" ADD VALUE IF NOT EXISTS 'SENTRY';
