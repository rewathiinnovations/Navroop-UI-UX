import type { NextRequest } from 'next/server';
import { readRequestId } from '@/lib/request-id';
import { runWithRequestContext, setRequestContextUser } from '@/lib/request-context';

export function withRequest<T>(request: NextRequest, fn: () => T, user?: { id?: string; workspaceId?: string }): T {
  const requestId = readRequestId(request.headers);
  return runWithRequestContext({ requestId, userId: user?.id, workspaceId: user?.workspaceId }, () => {
    if (user?.id) setRequestContextUser(user.id, user.workspaceId);
    return fn();
  });
}
