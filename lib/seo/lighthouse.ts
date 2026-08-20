import { withHeadlessBrowser } from '@/lib/audit/headless-browser';
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
    return [
      finding({
        id: 'lighthouse:unavailable',
        category: 'lighthouse',
        status: 'low',
        title: `Lighthouse ${PREVIEW_LABEL} unavailable`,
        detail: `Could not run Lighthouse against this preview URL. This is a ${PREVIEW_LABEL} only.`,
        fixable: false,
      }),
    ];
  }
}
