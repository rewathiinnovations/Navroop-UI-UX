import * as Sentry from '@sentry/nextjs';
import { log, logError } from '../logger';
import { setSentryActionContext } from '../sentry/context';

export function trackStart(
  event: string,
  fields: {
    action: string;
    stack?: string;
    workspaceId?: string;
    model?: string;
    step?: string;
  },
) {
  setSentryActionContext(fields);
  log.info(event, fields);
}

export function trackSuccess(
  event: string,
  fields: Record<string, unknown> & { action: string; durationMs?: number },
) {
  setSentryActionContext(fields);
  log.info(event, fields);
}

export function trackFailure(
  event: string,
  error: unknown,
  fields: Record<string, unknown> & { action: string; durationMs?: number; step?: string },
  deps?: { captureException?: typeof Sentry.captureException },
) {
  setSentryActionContext(fields);
  const status = typeof fields.status === 'number' ? fields.status : undefined;
  // One capture road: `logError` owns the Sentry call and the noise filter (F-735), so a
  // failure logged anywhere in the repo reaches the tracker exactly once. This function
  // keeps only the policy Sentry cannot know — the expected-status codes.
  logError(event, error, fields, {
    capture: !(status === 402 || status === 409 || status === 404),
    tags: {
      action: fields.action,
      stack: typeof fields.stack === 'string' ? fields.stack : undefined,
      workspaceId: typeof fields.workspaceId === 'string' ? fields.workspaceId : undefined,
    },
    extra: { step: fields.step, ...fields },
    captureException: deps?.captureException,
  });
}
