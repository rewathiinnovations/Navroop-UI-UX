import bcrypt from 'bcryptjs';
export { validateEmail } from '@/lib/email';

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function getSeedAdminCredentials() {
  const email = String(process.env.SEED_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '')
    .trim()
    .toLowerCase();
  const password = String(process.env.SEED_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '');
  return { email, password };
}
