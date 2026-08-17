import { timingSafeEqual } from 'node:crypto';

export function authorizeCron(request: Request) {
  const secret = process.env.CRON_SECRET ?? '';
  if (!secret) return false;
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
