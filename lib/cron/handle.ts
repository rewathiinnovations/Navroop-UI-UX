import { NextResponse } from 'next/server';
import { jsonError } from '../api/error-response';
import { readRequestId, REQUEST_ID_HEADER } from '../request-id';
import { authorizeCron } from './auth';
import { withCronRun, type CronOutcome } from './record';

export async function handleCron<T extends CronOutcome>(
  name: string,
  request: Request,
  fn: () => Promise<T>,
) {
  if (!(await authorizeCron(request))) {
    return jsonError('Unauthorized', 'UNAUTHORIZED', 401);
  }
  try {
    // No response mapper. There used to be an optional one, and every route that passed it
    // skipped the `!result.ok` branch below — a cron could report a failed run and still answer
    // 200 to Coolify's scheduler. No route used it.
    const result = await withCronRun(name, fn);
    if (!result.ok) {
      // The cron reports its own failure shape and may carry diagnostic fields,
      // so the body is passed through; only the correlation id is added.
      return NextResponse.json(result, {
        status: 500,
        headers: { [REQUEST_ID_HEADER]: readRequestId(request.headers) },
      });
    }
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(message, 'CRON_FAILED', 500);
  }
}
