import { createHmac, timingSafeEqual } from 'node:crypto';

export const PREVIEW_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

export type PreviewTokenPayload = {
  projectId: string;
  userId: string;
  exp: number;
};

export type TokenOptions = {
  secret: string;
  now: number;
  ttlMs?: number;
};

export type VerifyOptions = {
  secret: string;
  now: number;
  projectId: string;
};

export type VerifyResult =
  | { ok: true; projectId: string; userId: string; exp: number }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'mismatch' };

function previewSecret(explicit?: string) {
  const secret =
    explicit ||
    process.env.AUTH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error('AUTH_SECRET is required to sign preview tokens');
  return secret;
}

function signBody(body: string, secret: string) {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function signPreviewToken(
  input: { projectId: string; userId: string },
  options: TokenOptions,
) {
  const ttl = options.ttlMs ?? PREVIEW_TOKEN_TTL_MS;
  const payload: PreviewTokenPayload = {
    projectId: input.projectId,
    userId: input.userId,
    exp: options.now + ttl,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${signBody(body, options.secret)}`;
}

export function verifyPreviewToken(
  token: string | null | undefined,
  options: VerifyOptions,
): VerifyResult {
  if (!token) return { ok: false, reason: 'missing' };
  const [body, sig] = token.split('.');
  if (!body || !sig) return { ok: false, reason: 'invalid' };

  const expected = signBody(body, options.secret);
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { ok: false, reason: 'invalid' };
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PreviewTokenPayload;
    if (!payload.projectId || !payload.userId || !payload.exp) {
      return { ok: false, reason: 'invalid' };
    }
    if (payload.exp <= options.now) return { ok: false, reason: 'expired' };
    if (payload.projectId !== options.projectId) return { ok: false, reason: 'mismatch' };
    return { ok: true, projectId: payload.projectId, userId: payload.userId, exp: payload.exp };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

export function issuePreviewToken(
  input: { projectId: string; userId: string },
  now = Date.now(),
) {
  return signPreviewToken(input, { secret: previewSecret(), now, ttlMs: PREVIEW_TOKEN_TTL_MS });
}

export function checkPreviewToken(
  token: string | null | undefined,
  projectId: string,
  now = Date.now(),
) {
  return verifyPreviewToken(token, { secret: previewSecret(), now, projectId });
}
