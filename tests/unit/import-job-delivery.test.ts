/**
 * Delivery gaps after import honesty: the English exists, but it never
 * reached a pixel. These tests pin jobId, the import error code, and the
 * admin failed-row line. No network, no Firecrawl, no Playwright.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCKED_ACCESS_MESSAGE } from '@/lib/import/errors';
import { IMPORT_NO_FILES_MESSAGE } from '@/lib/import/copy';
import { UnsafeUrlError, URL_GUARD_MESSAGES } from '@/lib/security/url-guard';
import { RECOVERY_HEADING, isKnownJobErrorCode, recoveryCauseLine } from '@/lib/jobs/copy';
import { importJobErrorCode } from '@/lib/import/errors';
import { jobAdminFailureLine } from '@/lib/jobs/admin-display';

const ROUTE = path.join(process.cwd(), 'app/api/projects/[id]/import/route.ts');
const RECOVERY = path.join(process.cwd(), 'components/workspace/RecoveryPanel.tsx');
const JOBS_ADMIN = path.join(process.cwd(), 'app/(app)/admin/jobs/JobsAdmin.tsx');

const IMPORT_FAILED_CAUSE =
  'The import could not finish — the source page was blocked, rejected, or produced no files.';

// The jobId contract moved to tests/unit/import-persists-site.test.ts, which drives
// the real POST handler with `@/lib/import/run` mocked and asserts the argument object.
// It lived here as a source slice that ran to the first `}),` — a delimiter that only
// existed while the call sat inside a `Promise.race`. When that race was removed (it
// was throwing away finished imports whose tab had closed) the slice silently became
// an empty string and failed, naming a contract that had never broken. Scanning source
// text cannot tell "the code changed shape" from "the behaviour regressed".

describe('a hard import failure is not an AI failure', () => {
  it('has copy for import_failed that does not blame the AI or a failed build', () => {
    expect(isKnownJobErrorCode('import_failed')).toBe(true);
    expect(recoveryCauseLine('import_failed')).toBe(IMPORT_FAILED_CAUSE);
    expect(recoveryCauseLine('import_failed')).not.toBe('');
    expect(recoveryCauseLine('import_failed')).not.toBe(RECOVERY_HEADING);
    expect(recoveryCauseLine('import_failed')).not.toBe('The AI service did not respond');
    expect(recoveryCauseLine('import_failed').toLowerCase()).not.toMatch(/ai service/);
    expect(recoveryCauseLine('import_failed').toLowerCase()).not.toMatch(/build (failed|did not)/);
  });

  it('maps blocked pages, empty files, and SSRF to import_failed — not provider_error', () => {
    expect(importJobErrorCode(new Error(BLOCKED_ACCESS_MESSAGE))).toBe('import_failed');
    expect(importJobErrorCode(new Error(IMPORT_NO_FILES_MESSAGE))).toBe('import_failed');
    expect(importJobErrorCode(new UnsafeUrlError('private'))).toBe('import_failed');
    expect(importJobErrorCode(new Error(URL_GUARD_MESSAGES.private))).toBe('import_failed');
    expect(importJobErrorCode(new Error('The AI service did not respond'))).toBe('provider_error');
  });

  it('the import route failJob uses the classifier, not a hard-coded provider_error', () => {
    const source = readFileSync(ROUTE, 'utf8');
    expect(source).toMatch(/importJobErrorCode/);
    expect(source).not.toMatch(/failJob\([^)]*errorCode:\s*'provider_error'/);
  });
});

describe('soft Firecrawl English stays in chat, not the recovery panel', () => {
  it('generation RecoveryPanel still does not list steps', () => {
    const source = readFileSync(RECOVERY, 'utf8');
    expect(source).toMatch(/variant === 'publish' && steps/);
    expect(source).not.toMatch(/variant === 'generation' && steps/);
  });
});

describe('/admin/jobs failed rows show the honest sentence', () => {
  it('prefers errorMessage over lastStep so a blocked import is not just "import"', () => {
    expect(
      jobAdminFailureLine({
        lastStep: 'import',
        errorMessage: BLOCKED_ACCESS_MESSAGE,
      }),
    ).toBe(BLOCKED_ACCESS_MESSAGE);
    expect(jobAdminFailureLine({ lastStep: 'import', errorMessage: null })).toBe('import');
    expect(jobAdminFailureLine({ lastStep: null, errorMessage: null })).toBe('no step');
  });

  it('JobsAdmin renders the helper, not lastStep alone, on failed rows', () => {
    const source = readFileSync(JOBS_ADMIN, 'utf8');
    expect(source).toMatch(/job\.kind\} · \{jobAdminFailureLine\(job\)\}/);
    expect(source).not.toMatch(/job\.kind\} · \{job\.lastStep/);
  });
});
