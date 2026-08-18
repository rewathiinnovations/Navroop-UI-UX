import { NextResponse } from 'next/server';
import { jsonError } from '../api/error-response';
import { readRequestId, REQUEST_ID_HEADER } from '../request-id';
import { authorizeCron } from './auth';
import { withCronRun } from './record';

export async function handleCron(
  name: string,
  request: Request,
  fn: () => Promise<unknown>,
  map?: (result: unknown) => NextResponse,
) {
  if (!(await authorizeCron(request))) {
    return jsonError('Unauthorized', 'UNAUTHORIZED', 401);
  }
  try {
    const result = await withCronRun(name, fn);
    if (map) return map(result);
    if (result && typeof result === 'object' && 'ok' in result && (result as { ok: unknown }).ok === false) {
      // The cron reports its own failure shape and may carry diagnostic fields,
      // so the body is passed through; only the correlation id is added.
      return NextResponse.json(result, {
        status: 500,
        headers: { [REQUEST_ID_HEADER]: readRequestId(request.headers) },
      });
    }
    return NextResponse.json(result ?? { ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(message, 'CRON_FAILED', 500);
  }
}
