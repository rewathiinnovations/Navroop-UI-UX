import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QUALITY_SCORE_WEIGHTS,
  QUALITY_SIGNAL_KINDS,
  RUNTIME_ERRORS_KIND,
  runtimeErrorScore,
} from '@/lib/signals/score';
import type { CodeAuditSignalInput } from '@/lib/signals/collect';

/**
 * THE PIPELINE HAD NO OPINION ABOUT WHETHER THE PAGE MOUNTS.
 *
 * `run-build-validation.ts` proves the module graph links, the import scan proves every
 * specifier resolves and `quality-check.ts` reads the source with regexes. A client
 * component that dereferences null on its first render, or throws inside a `useEffect`,
 * satisfies every one of them and still reaches the user as a blank preview — under a
 * Quality panel reporting that the imports resolve and the build compiles. Nothing in
 * `lib/` or `app/` called `page.on` at all, so no console error the generated site produced
 * was ever read by anything.
 *
 * The capture rides on the browser pass axe already pays for. Three properties are what
 * make it safe to ship, and all three are pinned below:
 *
 *  A. It cannot invent a defect out of the harness. The document `lib/preview/html.ts`
 *     builds carries an esm.sh import map, the Tailwind Play CDN, the `__preview/next-*`
 *     shims and a CSP naming exactly two script hosts; an offline build box loses two of
 *     those at once and Chromium narrates every loss on the console. Filed as findings,
 *     they are the failure `browserUnavailableFinding()` exists to avoid — our harness on
 *     the user's panel, unfixable by anything they write.
 *  B. Ids are stable. `mergeIgnoredFindings` carries an Ignore forward by id and
 *     `groupRecurringIssues` counts by category across 200 audits, so an id built from a
 *     timestamp, an array index — or a minified `:line:col` that moves on every rebuild —
 *     would make one unchanged defect read as new on every scan.
 *  C. "Nobody looked" stays distinguishable from "clean", the same rule F-705 wrote for
 *     the other three signals: `runtimeErrors` is null when no browser opened the page.
 */

const browser = vi.hoisted(() => ({ withHeadlessBrowser: vi.fn() }));

vi.mock('@/lib/audit/headless-browser', () => browser);
// The provider call is out of scope here and drags in `ai` plus the whole credential
// chain; `runCodeScan` only needs the two names it imports from this module.
vi.mock('@/lib/audit/ai-review', () => ({
  runAiReview: vi.fn(async () => ({ findings: [], usage: null })),
  aiReviewNeedsScanFinding: () => ({
    id: 'tool:ai-review:needs-scan',
    category: 'tool' as const,
    status: 'low' as const,
    title: 'AI code review not run yet',
    detail: 'Press Scan.',
    fixable: false,
    ignored: false,
  }),
}));

import { dedupeA11yAgainstSeo, runA11yAudit } from '@/lib/audit/a11y';
import { asCodeFindings } from '@/lib/audit/findings';
import {
  RUNTIME_MESSAGE_LIMIT,
  captureRuntimeMessages,
  isPreviewHarnessNoise,
  normaliseRuntimeText,
  runtimeCleanFinding,
  runtimeFindingId,
  runtimeFindings,
  type RuntimeMessage,
} from '@/lib/audit/runtime-errors';
import { runCodeScan } from '@/lib/audit/scan';
import type { CodeFinding } from '@/lib/audit/types';
import type { SeoFinding } from '@/lib/seo/types';

/**
 * The URL the audit actually visits — `signedPreviewUrl`'s output, capability token and
 * all. Every stack frame the page produces names this document, because the bundle is
 * served as an inline `<script type="module">`.
 */
const PREVIEW_URL = 'https://preview-static.example.com/p1/?token=eyJhbGciOiJIUzI1NiJ9.SECRET';

/** What one page load will say. `console` entries carry the type Chromium gave them. */
type ScriptedEvent =
  | { event: 'pageerror'; error: Error }
  | { event: 'console'; type: string; text: string; url?: string };

function message(kind: RuntimeMessage['kind'], text: string, source: string | null = null) {
  return { kind, text, source } satisfies RuntimeMessage;
}

/**
 * A page that replays `script` at `goto` time, which is when a mount error happens.
 *
 * Deliberately not a Playwright stub with a `waitForEvent` of its own: what is under test
 * is that the listeners are attached *before* the navigation, and a fake that fires its
 * events during `goto` is the only one that can fail if they are not.
 */
function fakeBrowser(script: ScriptedEvent[]) {
  return {
    newPage: async () => {
      const handlers = new Map<string, Array<(arg: unknown) => void>>();
      return {
        on(event: string, handler: (arg: unknown) => void) {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        async goto() {
          for (const item of script) {
            if (item.event === 'pageerror') {
              for (const handler of handlers.get('pageerror') ?? []) handler(item.error);
              continue;
            }
            const consoleMessage = {
              type: () => item.type,
              text: () => item.text,
              location: () => ({ url: item.url ?? '', lineNumber: 1, columnNumber: 1 }),
            };
            for (const handler of handlers.get('console') ?? []) handler(consoleMessage);
          }
          return null;
        },
        async addScriptTag() {
          return null;
        },
        async evaluate() {
          return [];
        },
        async close() {
          return undefined;
        },
      };
    },
  };
}

type BrowserTask = (context: { browser: unknown; debugPort: number | null }) => Promise<unknown>;

function withScriptedPage(script: ScriptedEvent[]) {
  browser.withHeadlessBrowser.mockImplementation(async (task: BrowserTask) =>
    task({ browser: fakeBrowser(script), debugPort: null }),
  );
}

/** Playwright's own shape for an uncaught throw: the class in `name`, the text in `message`. */
function pageError(name: string, text: string, stack: string): Error {
  const error = new Error(text);
  error.name = name;
  error.stack = stack;
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ------------------------------- A: the harness is never a defect in the user's site */

describe('the preview harness cannot be filed as a finding', () => {
  const noise: RuntimeMessage[] = [
    message(
      'console',
      'Failed to load resource: net::ERR_NAME_NOT_RESOLVED',
      'https://esm.sh/react@19.2.0',
    ),
    message('exception', 'TypeError: Failed to fetch dynamically imported module', null),
    message('console', 'Uncaught TypeError: Failed to resolve module specifier "lucide-react"'),
    message('console', 'GET https://cdn.tailwindcss.com/ net::ERR_CONNECTION_REFUSED'),
    message('exception', 'TypeError: window.__previewNavigate is not a function'),
    message(
      'console',
      'Uncaught Error: boom',
      'https://preview-static.example.com/__preview/next-navigation.ts',
    ),
    message(
      'console',
      "Refused to load the script 'https://cdn.example.com/x.js' because it violates the following Content Security Policy directive",
    ),
    message('console', 'Failed to load resource: the server responded with a status of 404'),
    message('console', 'Access to font at https://fonts.gstatic.com/x.woff2 has been blocked'),
  ];

  it('drops every message the platform produces about itself', () => {
    for (const row of noise) {
      expect(isPreviewHarnessNoise(row)).toBe(true);
    }
    // …and the whole batch therefore reads as a page that ran clean, not as nine defects.
    expect(runtimeFindings(noise)).toEqual([runtimeCleanFinding()]);
  });

  /**
   * The case that decides whether this feature is worth having.
   *
   * `buildStaticSite` marks every bare specifier external and the served document resolves
   * them through the esm.sh import map, so React, react-dom and every package the model
   * imported *are* esm.sh modules at runtime. An error thrown inside a component therefore
   * carries an esm.sh stack frame, and a filter that matched the host against the frame
   * reported a page which crashed on mount as having run clean — the whole React-thrown
   * class, silently. Every one of these has a frame that names esm.sh; none of them is noise.
   */
  it('keeps a React or package throw, whose stack frame is always an esm.sh module', () => {
    const thrownInsideADependency = [
      message(
        'exception',
        'Error: Objects are not valid as a React child (found: object with keys {title})',
        'https://esm.sh/react-dom@19.2.0/es2022/client.mjs',
      ),
      message(
        'exception',
        'Error: Minified React error #185; visit https://react.dev/errors/185',
        'https://esm.sh/react-dom@19.2.0/es2022/client.mjs',
      ),
      message(
        'exception',
        'Error: Rendered more hooks than during the previous render.',
        'https://esm.sh/react@19.2.0/es2022/react.mjs',
      ),
      message(
        'console',
        'Uncaught TypeError: icon is not a function',
        'https://esm.sh/lucide-react@0.548.0/es2022/lucide-react.mjs',
      ),
    ];

    for (const row of thrownInsideADependency) {
      expect(isPreviewHarnessNoise(row), row.text).toBe(false);
    }
    expect(runtimeFindings(thrownInsideADependency)).toHaveLength(4);
  });

  it('still drops a message that names esm.sh as its own subject', () => {
    // The distinction the split rests on: the module *failed to load* (harness), versus code
    // *inside* a loaded module threw (the site). Only the first names the host in its text.
    expect(
      isPreviewHarnessNoise(
        message('console', 'Failed to load resource: https://esm.sh/react@19.2.0 404'),
      ),
    ).toBe(true);
  });

  it('keeps the errors that are about the generated code', () => {
    const real = [
      message('exception', "TypeError: Cannot read properties of undefined (reading 'map')"),
      message(
        'console',
        'Uncaught Error: Minified React error #185; visit https://react.dev/errors/185',
      ),
    ];
    for (const row of real) {
      expect(isPreviewHarnessNoise(row)).toBe(false);
    }
    expect(runtimeFindings(real)).toHaveLength(2);
  });

  it('lands advisory, never blocking, and offers the model no fix it would be guessing at', () => {
    const [row] = runtimeFindings([
      message('exception', "TypeError: Cannot read properties of undefined (reading 'map')"),
    ]);

    expect(row.category).toBe('runtime');
    expect(row.status).toBe('low');
    expect(row.fixable).toBe(false);
    expect(row.detail).toContain("Cannot read properties of undefined (reading 'map')");
  });
});

/* --------------------------------------- B: an id the next scan will produce again */

describe('runtime finding ids survive the next scan', () => {
  it('never carries the signed preview token into a finding', () => {
    const stack = `TypeError: x is not a function\n    at Object.render (${PREVIEW_URL}:412:19)`;
    const row = runtimeFindings([message('exception', stack, PREVIEW_URL)])[0];

    // The token is a live capability: findings are persisted to `CodeAudit` and rendered
    // on the panel, so anything that reaches a finding has left the process.
    for (const text of [row.id, row.title, row.detail]) {
      expect(text).not.toContain('SECRET');
      expect(text).not.toContain('token=');
    }
    expect(row.detail).toContain('https://preview-static.example.com/p1/');
  });

  it('does not move when the minified bundle does', () => {
    // `buildStaticSite` minifies with `sourcemap: false`, so a one-character edit anywhere
    // in the project renumbers every frame. An id built from the frame verbatim would make
    // an unchanged defect look new on every scan and poison `getTopRecurringIssues`.
    const before = message('exception', 'TypeError: t is not a function', `${PREVIEW_URL}:412:19`);
    const after = message('exception', 'TypeError: t is not a function', `${PREVIEW_URL}:98:7`);

    expect(runtimeFindingId(before)).toBe(runtimeFindingId(after));
  });

  it('carries no clock and no arrival order', () => {
    const row = message('console', 'Uncaught Error: boom');
    const first = runtimeFindingId(row);

    expect(runtimeFindingId(row)).toBe(first);
    expect(first).toMatch(/^runtime:uncaught-error-boom:[a-z0-9]+$/);
    expect(first).not.toMatch(/\d{10,}/);
  });

  it('gives two different errors two different ids, however long they are', () => {
    const prefix = 'TypeError: Cannot read properties of undefined (reading ';
    const left = message('exception', `${prefix}'someVeryLongPropertyNameOne')`);
    const right = message('exception', `${prefix}'someVeryLongPropertyNameTwo')`);

    expect(runtimeFindingId(left)).not.toBe(runtimeFindingId(right));
  });

  it('collapses a page erroring in a loop into one row', () => {
    const repeated = Array.from({ length: 40 }, () =>
      message('console', 'Uncaught TypeError: state.items is not iterable'),
    );

    expect(runtimeFindings(repeated)).toHaveLength(1);
  });

  it('normalises whitespace and positions so the same error reads the same way', () => {
    expect(normaliseRuntimeText(`Error:   boom\n    at fn (${PREVIEW_URL}:12:3)`)).toBe(
      'Error: boom at fn (https://preview-static.example.com/p1/)',
    );
  });
});

/* ------------------------------------------------- the capture itself is bounded */

describe('captureRuntimeMessages', () => {
  function recordingPage() {
    const handlers = new Map<string, Array<(arg: unknown) => void>>();
    return {
      page: {
        on(event: string, handler: (arg: unknown) => void) {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
      },
      emit(event: string, arg: unknown) {
        for (const handler of handlers.get(event) ?? []) handler(arg);
      },
    };
  }

  it('stops collecting at the cap, so a render loop cannot grow without bound', () => {
    const { page, emit } = recordingPage();
    const capture = captureRuntimeMessages(page as never);

    for (let index = 0; index < RUNTIME_MESSAGE_LIMIT * 10; index += 1) {
      emit('pageerror', pageError('TypeError', `boom ${index}`, ''));
    }

    expect(capture.messages()).toHaveLength(RUNTIME_MESSAGE_LIMIT);
  });

  it('listens to console errors only', () => {
    const { page, emit } = recordingPage();
    const capture = captureRuntimeMessages(page as never);

    for (const type of ['log', 'info', 'warning', 'debug', 'error']) {
      emit('console', {
        type: () => type,
        text: () => `a ${type} line`,
        location: () => ({ url: PREVIEW_URL, lineNumber: 1, columnNumber: 1 }),
      });
    }

    // The Play CDN warns on every load that it is not for production and a generated site
    // is entitled to log whatever it likes; neither is a defect.
    expect(capture.messages().map((row) => row.text)).toEqual(['a error line']);
  });

  it('does not repeat the error class when Playwright already put it in the message', () => {
    const { page, emit } = recordingPage();
    const capture = captureRuntimeMessages(page as never);

    emit('pageerror', pageError('TypeError', 'TypeError: x is not a function', ''));
    emit('pageerror', pageError('TypeError', 'x is not a function', ''));

    expect(capture.messages().map((row) => row.text)).toEqual([
      'TypeError: x is not a function',
      'TypeError: x is not a function',
    ]);
  });
});

/* --------------------------------- the browser pass carries both checks in one load */

describe('runA11yAudit reports what the page said', () => {
  it('captures an exception thrown during the load itself', async () => {
    withScriptedPage([
      {
        event: 'pageerror',
        error: pageError(
          'TypeError',
          "Cannot read properties of null (reading 'title')",
          `TypeError\n    at Hero (${PREVIEW_URL}:412:19)`,
        ),
      },
    ]);

    const findings = await runA11yAudit(PREVIEW_URL, []);
    const runtime = findings.filter((row) => row.category === 'runtime');

    // Both viewport passes see it; one defect, not two.
    expect(runtime).toHaveLength(1);
    expect(runtime[0].status).toBe('low');
    expect(runtime[0].detail).toContain("Cannot read properties of null (reading 'title')");
  });

  it('says the page ran clean rather than saying nothing', async () => {
    withScriptedPage([{ event: 'console', type: 'log', text: 'hello' }]);

    const findings = await runA11yAudit(PREVIEW_URL, []);

    expect(findings.filter((row) => row.category === 'runtime')).toEqual([runtimeCleanFinding()]);
  });

  it('asserts nothing about the runtime when no browser opened the page', async () => {
    const noPreview = await runA11yAudit(null, []);
    expect(noPreview.some((row) => row.category === 'runtime')).toBe(false);

    browser.withHeadlessBrowser.mockRejectedValue(
      new Error("browserType.launch: Executable doesn't exist at /ms-playwright/chromium/chrome"),
    );
    const noBrowser = await runA11yAudit(PREVIEW_URL, []);
    expect(noBrowser.some((row) => row.category === 'runtime')).toBe(false);
  });

  it('is not eaten by the axe/SEO overlap filter', async () => {
    // `dedupeA11yAgainstSeo` matches the word "title" anywhere in a finding's id, title or
    // detail. A runtime row quotes the page's own error text, so a TypeError about a
    // `title` property would vanish because the SEO audit happened to report a missing page
    // title — an overlap that does not exist, between two checks that never restate one
    // another.
    const seo: SeoFinding[] = [
      {
        id: 'metadata:title',
        category: 'metadata',
        status: 'medium',
        title: 'Page title is missing',
        detail: 'Add a <title>.',
        fixable: true,
        ignored: false,
      },
    ];
    withScriptedPage([
      {
        event: 'console',
        type: 'error',
        text: "Uncaught TypeError: Cannot read properties of null (reading 'title')",
        url: PREVIEW_URL,
      },
    ]);

    const findings = await runA11yAudit(PREVIEW_URL, seo);

    expect(findings.filter((row) => row.category === 'runtime')).toHaveLength(1);
    // The filter itself still works on the category it was written for.
    const a11yRow: CodeFinding = {
      id: 'a11y:document-title:html',
      category: 'a11y',
      status: 'medium',
      title: 'Documents must have a title',
      detail: 'Documents must have a title (desktop).',
      fixable: true,
      ignored: false,
    };
    expect(dedupeA11yAgainstSeo([a11yRow], seo)).toEqual([]);
  });
});

/* ---------------------------------- C: a check nobody ran asserts nothing (F-705) */

describe('runCodeScan counts the runtime check only when the browser loaded', () => {
  const scanInput = {
    stack: 'NEXTJS' as const,
    files: [],
    previewUrl: PREVIEW_URL,
    sandbox: null,
    seoFindings: [],
    userId: 'user-1',
  };

  it('records the count and the verdict when a page was actually opened', async () => {
    withScriptedPage([
      { event: 'console', type: 'error', text: 'Uncaught TypeError: items is not iterable' },
    ]);

    const result = await runCodeScan({ ...scanInput, depth: 'full' });

    expect(result.signals.runtimeErrors).toBe(1);
    // The four static checks and the bundle measure all report "no runner" on this
    // deployment, so the browser pass is the entire count: axe plus the runtime capture.
    expect(result.checksRun).toBe(2);
    expect(result.findings.filter((row) => row.category === 'runtime')).toHaveLength(1);
  });

  it('reads a clean page as zero, not as a check that did not run', async () => {
    withScriptedPage([]);

    const result = await runCodeScan({ ...scanInput, depth: 'full' });

    expect(result.signals.runtimeErrors).toBe(0);
    expect(result.checksRun).toBe(2);
  });

  it('asserts nothing at static depth, where no browser is launched', async () => {
    const result = await runCodeScan({ ...scanInput, depth: 'static' });

    expect(result.signals.runtimeErrors).toBeNull();
    expect(result.checksRun).toBe(0);
    expect(browser.withHeadlessBrowser).not.toHaveBeenCalled();
  });

  it('asserts nothing when the deployment has no browser to launch', async () => {
    browser.withHeadlessBrowser.mockRejectedValue(
      new Error("browserType.launch: Executable doesn't exist at /ms-playwright/chromium/chrome"),
    );

    const result = await runCodeScan({ ...scanInput, depth: 'full' });

    expect(result.signals.runtimeErrors).toBeNull();
    expect(result.signals.axeViolations).toBeNull();
    expect(result.checksRun).toBe(0);
  });
});

/* --------------------------------- the category has to survive the database round trip */

describe('stored runtime findings come back', () => {
  it('is a category `asCodeFindings` accepts', () => {
    const stored = JSON.parse(
      JSON.stringify(runtimeFindings([message('exception', 'TypeError: boom')])),
    ) as unknown;

    // `asCodeFindings` drops any row whose category it does not know, so a category added
    // to the union and not to that list would be written by the scan and then silently
    // disappear on every read — including `groupRecurringIssues`, which reads back 200
    // audits straight out of Postgres.
    expect(asCodeFindings(stored)).toHaveLength(1);
    expect(asCodeFindings(stored)[0].category).toBe('runtime');
  });
});

/**
 * The signal, which the first version of this feature wrote and nothing stored.
 *
 * `runtimeErrors` sat on `CodeScanSignals` and reached `recordCodeAuditSignals` through the
 * `...scanned.signals` spread — but `CodeAuditSignalInput` did not declare it, and TypeScript
 * does not excess-property-check a spread, so it compiled, looked wired, and persisted
 * nothing. These pin both halves: the score exists, and it stays outside the composite.
 */
describe('runtime errors as a quality signal', () => {
  it('scores a clean page 1 and gets steeply worse with the first error', () => {
    expect(runtimeErrorScore(0)).toBe(1);
    expect(runtimeErrorScore(1)).toBe(0.5);
    expect(runtimeErrorScore(1)).toBeLessThan(runtimeErrorScore(0));
    expect(runtimeErrorScore(4)).toBeLessThan(runtimeErrorScore(1));
  });

  it('flattens out, because "very broken" needs no more resolution than "broken"', () => {
    expect(runtimeErrorScore(20) - runtimeErrorScore(40)).toBeLessThan(0.05);
  });

  it('stays out of the composite, whose eight weights must keep summing to 1', () => {
    expect(QUALITY_SIGNAL_KINDS).not.toContain(RUNTIME_ERRORS_KIND);
    expect(Object.keys(QUALITY_SCORE_WEIGHTS)).not.toContain(RUNTIME_ERRORS_KIND);
    const sum = Object.values(QUALITY_SCORE_WEIGHTS).reduce((total, weight) => total + weight, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('is declared on the collector input, which is what the spread needs to survive', () => {
    // The defect was invisible to tsc; the only honest check is that the field is named in
    // the type the collector reads, so a future rename cannot quietly unwire it again.
    const input: CodeAuditSignalInput = { projectId: 'p1', runtimeErrors: 3 };
    expect(input.runtimeErrors).toBe(3);
  });
});
