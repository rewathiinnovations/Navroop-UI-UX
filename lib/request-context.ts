import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestContext = {
  requestId: string;
  userId?: string;
  workspaceId?: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext() {
  return storage.getStore();
}

export function getRequestId() {
  return storage.getStore()?.requestId;
}

export function setRequestContextUser(userId?: string, workspaceId?: string) {
  const current = storage.getStore();
  if (!current) return;
  if (userId) current.userId = userId;
  if (workspaceId) current.workspaceId = workspaceId;
}
