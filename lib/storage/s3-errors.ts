/**
 * Telling "that object is not there" apart from "that request failed".
 *
 * `get` and `exists` may only answer `null` / `false` for an object that is genuinely
 * absent. Every other failure — credentials rejected, throttled, bucket misnamed,
 * endpoint unreachable — has to throw, because a caller that cannot tell the two apart
 * will confidently give a wrong answer: a stale sandbox tree, a stale published site, a
 * "your version is gone" message, or an empty ZIP.
 *
 * Verified against the installed @aws-sdk/client-s3 (3.1111.0) rather than assumed, by
 * replaying canned HTTP responses through a real `S3Client` with a stub request handler.
 * `tests/unit/s3-not-found.test.ts` is that experiment kept as a test:
 *
 *   GetObject  404 + <Error><Code>NoSuchKey</Code>    -> name "NoSuchKey",    404  absent
 *   GetObject  404 + no parseable body                -> name "NotFound",    404  absent
 *   GetObject  404 + <Error><Code>NoSuchBucket</Code> -> name "NoSuchBucket", 404  NOT absent
 *   GetObject  403 / 503                              -> name "AccessDenied" / "SlowDown"
 *   GetObject  500 + no body                          -> name "Unknown",     500
 *   HeadObject 404                                    -> name "NotFound",    404  absent
 *   HeadObject 403 / 400 / 500                        -> name "Unknown", status preserved
 *   transport failure (ECONNREFUSED, DNS, TLS)        -> plain Error, no `$metadata`
 *
 * Two consequences drive the checks below. A HEAD response has no body, so S3 cannot
 * name the error and the SDK falls back to the status code — the name alone is not
 * enough, which is why the status is checked too. And `NoSuchBucket` also answers 404,
 * so the status alone is not enough either: a wrong or deleted bucket is an operator
 * problem about the whole store, not a verdict about one key.
 */

/** Names S3 uses for "this key is not in the bucket". */
const OBJECT_ABSENT_NAMES = new Set(['NoSuchKey', 'NotFound']);

/** 404s that are not about the key. Never read these as an absent object. */
const NOT_ABOUT_THE_KEY = new Set(['NoSuchBucket']);

function readErrorName(error: object): string {
  if (!('name' in error)) return '';
  const name = (error as { name: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function readHttpStatus(error: object): number | null {
  if (!('$metadata' in error)) return null;
  const metadata = (error as { $metadata: unknown }).$metadata;
  if (typeof metadata !== 'object' || metadata === null || !('httpStatusCode' in metadata)) {
    return null;
  }
  const status = (metadata as { httpStatusCode: unknown }).httpStatusCode;
  return typeof status === 'number' ? status : null;
}

/**
 * True only when S3 answered and said the object is not there.
 *
 * An error with no `$metadata` never reached the service (DNS, TLS, refused connection,
 * abort), so it carries no answer about the object and must not be read as one.
 */
export function isObjectNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = readHttpStatus(error);
  if (status === null) return false;
  const name = readErrorName(error);
  if (NOT_ABOUT_THE_KEY.has(name)) return false;
  if (OBJECT_ABSENT_NAMES.has(name)) return true;
  return status === 404;
}
