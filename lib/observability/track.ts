import * as Sentry from '@sentry/nextjs';
import { log, logError } from '../logger';
import { setSentryActionContext } from '../sentry/context';
import { shouldCaptureException } from './noise';

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

export function trackSuccess(event: string, fields: Record<string, unknown> & { action: string; durationMs?: number }) {
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
  logError(event, error, fields);
  const status = typeof fields.status === 'number' ? fields.status : undefined;
  if (status === 402 || status === 409 || status === 404) return;
  if (!shouldCaptureException(error)) return;
  const capture = deps?.captureException ?? Sentry.captureException;
  capture(error, {
    tags: {
      action: fields.action,
      stack: typeof fields.stack === 'string' ? fields.stack : undefined,
      workspaceId: typeof fields.workspaceId === 'string' ? fields.workspaceId : undefined,
    },
    extra: { step: fields.step, ...fields },
  });
}
