import { withHeadlessBrowser } from '@/lib/audit/headless-browser';
// The predicate lives with the audit's browser code because that is the subsystem
// that owns `withHeadlessBrowser`; both callers of it owe the user the same answer
// when the deployment has no Chromium, and two copies of one regex is how they stop
// agreeing.
import { isBrowserUnavailableError } from '@/lib/audit/a11y';
import { capLighthouseSeverity, finding } from './findings';
import type { SeoFinding, SeoSeverity } from './types';

const PREVIEW_LABEL = 'preview-environment estimate';

type LighthouseAudit = {
  id?: string;
  title?: string;
  description?: string;
  score?: number | null;
};

type LighthouseResult = {
  lhr?: {
    audits?: Record<string, LighthouseAudit>;
    categories?: { seo?: { score?: number | null } };
  };
};

function scoreToStatus(score: number | null | undefined): SeoSeverity {
  if (score == null) return 'low';
  if (score >= 0.9) return 'pass';
  if (score >= 0.5) return 'low';
  return 'medium';
}

export function findingsFromLighthouse(result: LighthouseResult | null | undefined): SeoFinding[] {
  const audits = result?.lhr?.audits || {};
  const out: SeoFinding[] = [];
  for (const audit of Object.values(audits)) {
    if (!audit?.id || audit.score == null) continue;
    const status = capLighthouseSeverity(scoreToStatus(audit.score));
    if (status === 'pass') continue;
    out.push(
      finding({
        id: `lighthouse:${audit.id}`,
        category: 'lighthouse',
        status,
        title: `${audit.title || audit.id} (${PREVIEW_LABEL})`,
        detail: `${audit.description || 'Lighthouse SEO audit.'} This is a ${PREVIEW_LABEL} — scores from the sandbox preview, not production.`,
        fixable: true,
      }),
    );
  }
  return out;
}

/** Preview URL only. Never marks a finding high. */
export async function runLighthouseSeo(previewUrl: string): Promise<SeoFinding[]> {
  if (!previewUrl.trim()) return [];
  try {
    // One browser at a time, on an OS-assigned debugging port. Two concurrent
    // SEO audits used to pick the same random `--remote-debugging-port` with no
    // collision check, so Lighthouse could attach to the other audit's browser
    // and score the wrong page; the run also had no timeout (F-751).
    return await withHeadlessBrowser(
      async ({ debugPort }) => {
        // Loaded here, not at module scope: `lighthouse` is a heavy ESM-only
        // package and this is the only place it runs, so it stays out of the
        // graph until an SEO audit actually needs it.
        const lighthouse = (await import('lighthouse')).default;
        const result = (await lighthouse(previewUrl, {
          port: debugPort ?? undefined,
          output: 'json',
          onlyCategories: ['seo'],
          logLevel: 'error',
        })) as LighthouseResult | undefined;
        return findingsFromLighthouse(result);
      },
      { debugPort: true },
    );
  } catch (error) {
    console.warn('[seo] lighthouse run failed', error);
    // `info`, not `low`. `low` is a defect in the user's site, and this row is about
    // ours: the run did not happen, so there is nothing here they could have done
    // differently and nothing for the score to weigh (`info` is excluded from it,
    // F-755). It used to be filed as a real finding, which put a permanent
    // pseudo-defect on every project of any deployment with no browser installed.
    // The wording splits the two causes because they have different first moves —
    // an operator installs a browser; anyone else retries.
    return [
      finding({
        id: 'lighthouse:unavailable',
        category: 'lighthouse',
        status: 'info',
        title: isBrowserUnavailableError(error)
          ? 'Lighthouse is unavailable on this deployment'
          : `Lighthouse ${PREVIEW_LABEL} unavailable`,
        detail: isBrowserUnavailableError(error)
          ? 'This installation has no headless browser, so Lighthouse could not be run. Nothing is wrong with your site — an operator has to install the browser for this check to work.'
          : `Could not run Lighthouse against this preview URL. This is a ${PREVIEW_LABEL} only.`,
        fixable: false,
      }),
    ];
  }
}

/**
 * The row that says Lighthouse is waiting for the user, not that it failed.
 *
 * An automatic post-build scan runs only the free, fast checks, and Lighthouse forks a
 * Chromium — so it stays behind the Scan button where the user asked for it. `info`
 * renders under the SEO panel's "Not checked" notices and is excluded from the SEO
 * score, which is exactly right: an unrun check must not read as a clean one, and a
 * panel that silently shows partial results is a worse lie than showing nothing.
 */
export function lighthouseNeedsScanFinding(): SeoFinding {
  return finding({
    id: 'lighthouse:needs-scan',
    category: 'lighthouse',
    status: 'info',
    title: 'Lighthouse not run yet',
    detail:
      'The automatic check after a build runs only the free, fast checks. Lighthouse opens your site in a browser, so it runs when you press Scan.',
    fixable: false,
  });
}
