/**
 * Request-id helper + structured logger shape.
 * Run: npx tsx tests/logger-scrub.test.ts
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequestId, REQUEST_ID_HEADER, readRequestId } from '../lib/request-id.ts';
import { getRequestId, runWithRequestContext } from '../lib/request-context.ts';
import { formatLogLine } from '../lib/logger.ts';
import { jsonError, errorPayload } from '../lib/api/error-response.ts';

let failed = 0;
let passed = 0;

function assert(cond: unknown, name: string) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
}

const id = createRequestId();
assert(typeof id === 'string' && id.length === 12, 'createRequestId is 12 chars');
assert(/^[A-Za-z0-9_-]+$/.test(id), 'createRequestId is url-safe nanoid');
assert(createRequestId() !== createRequestId(), 'createRequestId is unique');
assert(REQUEST_ID_HEADER === 'x-request-id', 'header name is x-request-id');
assert(
  readRequestId({ get: (name: string) => (name === 'x-request-id' ? 'abc123xyz999' : null) }) ===
    'abc123xyz999',
  'readRequestId reads x-request-id',
);
assert(
  readRequestId({ get: () => null }).length === 12,
  'readRequestId generates when missing',
);

await runWithRequestContext({ requestId: 'req_test_12', userId: 'u1', workspaceId: 'ws1' }, async () => {
  assert(getRequestId() === 'req_test_12', 'ALS getRequestId inside context');
  const line = formatLogLine('info', 'generation.start', { durationMs: 12, stack: 'NEXTJS' });
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert(parsed.level === 'info', 'log level');
  assert(parsed.event === 'generation.start', 'log event name');
  assert(parsed.requestId === 'req_test_12', 'log requestId from ALS');
  assert(parsed.userId === 'u1', 'log userId from ALS');
  assert(parsed.workspaceId === 'ws1', 'log workspaceId from ALS');
  assert(parsed.durationMs === 12, 'log duration when relevant');
  assert(typeof parsed.timestamp === 'string', 'log timestamp');
  assert(!line.includes('\n'), 'log is one line');
});

assert(getRequestId() === undefined || getRequestId() === '', 'ALS empty outside context');
assert(AsyncLocalStorage !== undefined, 'AsyncLocalStorage available');

const payload = errorPayload('Something went wrong', 'GENERATION_FAILED', 'req_err_12ab');
assert(payload.error.message === 'Something went wrong', 'error message');
assert(payload.error.code === 'GENERATION_FAILED', 'error code');
assert(payload.error.requestId === 'req_err_12ab', 'error requestId');

const response = jsonError('Something went wrong', 'INTERNAL', 500, 'req_json_12x');
assert(response.status === 500, 'jsonError status');
const body = await response.json();
assert(body.error.requestId === 'req_json_12x', 'jsonError body requestId');
assert(body.error.code === 'INTERNAL', 'jsonError body code');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
