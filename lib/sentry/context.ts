import * as Sentry from '@sentry/nextjs';
import { getRequestContext } from '@/lib/request-context';

export function setSentryActionContext(input: {
  action: string;
  stack?: string;
  workspaceId?: string;
  requestId?: string;
}) {
  const ctx = getRequestContext();
  const workspaceId = input.workspaceId ?? ctx?.workspaceId;
  const requestId = input.requestId ?? ctx?.requestId;
  Sentry.setTag('action', input.action);
  if (input.stack) Sentry.setTag('stack', input.stack);
  if (workspaceId) Sentry.setTag('workspaceId', workspaceId);
  if (requestId) Sentry.setTag('requestId', requestId);
  Sentry.setContext('navroop', {
    action: input.action,
    stack: input.stack,
    workspaceId,
    requestId,
  });
}
