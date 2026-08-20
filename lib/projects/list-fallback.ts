import { Prisma } from '@/generated/prisma';

/**
 * F-804: `listProjects` wrapped its Prisma query in a bare `catch {}` and re-ran
 * the list as raw SQL. The comment justified it for one cause — a stale Prisma
 * client whose DMMF predates a column that now exists — but the catch had no
 * discrimination, so a connection-pool exhaustion, a permissions error or a
 * genuine schema break all silently took the fallback and were reported to the
 * user as a successful list.
 *
 * This names the one cause the fallback exists for. Everything else is a real
 * failure and must surface as one.
 *
 * - `PrismaClientValidationError` is what a generated client raises when the
 *   query names a field its own DMMF does not know (the pre-`phase`/`stars`
 *   case).
 * - P2021 / P2022 are the reverse drift: the client knows a table or column the
 *   database has not got yet.
 */
const STALE_SCHEMA_CODES: Record<string, true> = { P2021: true, P2022: true };

export function isStaleClientError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientValidationError) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return STALE_SCHEMA_CODES[error.code] === true;
  }
  return false;
}
