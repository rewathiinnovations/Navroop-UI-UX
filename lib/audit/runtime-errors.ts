import type { ConsoleMessage, Page } from 'playwright';
import { finding } from './findings';
import type { CodeFinding } from './types';

/**
 * What the generated page said while the audit already had it open.
 *
 * Nothing else in the pipeline listens to the running page. The esbuild pass in
 * `lib/validation/run-build-validation.ts` proves the module graph links, the import scan
 * proves every specifier resolves, and `quality-check.ts` reads the source with regexes —
 * a client component that dereferences null on its first render, or throws inside a
 * `useEffect`, satisfies all three and still reaches the user as a blank or half-rendered
 * preview, under a Quality panel reporting that the imports resolve and the build compiles.
 * That is the whole gap this closes: `axeOnPage` already owns a Playwright page and already
 * waits for the same `networkidle` load, so two listeners attached before its `goto` are
 * the entire cost of noticing.
 */

/**
 * How many messages one page load may contribute.
 *
 * A component that throws inside a render loop, or a `useEffect` that sets state on every
 * commit, produces console errors for as long as the page is open — which here is until
 * `networkidle` plus an axe run, easily thousands. Without a ceiling the array grows inside
 * the serving process (the browser runs in-process; see `lib/audit/headless-browser.ts`),
 * and every one of them would have to be normalised and hashed afterwards. The repeats
 * collapse to a single finding anyway, because the id is derived from the message rather
 * than from the arrival order, so the ceiling costs nothing a reader would have wanted.
 */
export const RUNTIME_MESSAGE_LIMIT = 20;

export type RuntimeMessage = {
  /** `exception` is an uncaught throw; `console` is a `console.error` the page made. */
  kind: 'exception' | 'console';
  text: string;
  /** First stack frame, or the console location — scrubbed. Null when the browser gave none. */
  source: string | null;
};

/** Used with `.test()` and `.match()`, so deliberately not `/g`: a global regex carries `lastIndex`. */
const URL_PATTERN = /https?:\/\/[^\s'"`)\]]+/;
const URL_PATTERN_ALL = /https?:\/\/[^\s'"`)\]]+/g;

/**
 * A URL from a stack frame, cut back to the part that is the same on the next scan.
 *
 * Two reasons, and the first is not cosmetic. The URL the audit visits is
 * `signedPreviewUrl`'s output — `https://preview-static.<zone>/<projectId>/?token=<jwt>` —
 * and the bundle is served as an inline `<script type="module">`, so every stack frame the
 * page produces names that document, token and all. Findings are persisted to `CodeAudit`
 * and rendered on the panel, so leaving the query in would write a live capability token
 * into the database and onto the screen. The query is cut before anything else looks at
 * the string, rather than by a parser that might not recognise the shape.
 *
 * The trailing `:line:col` goes for the second reason: `buildStaticSite` minifies with
 * `sourcemap: false`, so those numbers move on any edit anywhere in the project. Left in,
 * they would make the id in {@link runtimeFindingId} change on every rebuild and every
 * scan would report every error as new — which is the thing that poisons
 * `getTopRecurringIssues`.
 */
export function scrubLocation(raw: string): string {
  const [beforeQuery] = raw.split(/[?#]/);
  return beforeQuery.replace(/:\d+(?::\d+)?$/, '');
}

/** The message with its URLs scrubbed and its whitespace flattened — the id's input, and the panel's. */
export function normaliseRuntimeText(text: string): string {
  return text
    .replace(URL_PATTERN_ALL, (match) => scrubLocation(match))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Scrubbed a second time, here rather than only at the capture.
 *
 * `captureRuntimeMessages` already runs every source through {@link scrubLocation}, so on
 * the real path this is idempotent. It is not there for the real path: the guarantee that
 * no signed preview token reaches a persisted finding, and that no minified `:line:col`
 * reaches an id, has to be a property of the thing that builds findings rather than a
 * promise about the one caller that exists today. The first version trusted the caller,
 * and the tests caught both halves at once — a token in `detail` and an id that changed
 * when the bundle was rebuilt.
 */
function normaliseSource(source: string | null): string | null {
  return source ? scrubLocation(source) : null;
}

/**
 * Everything the preview harness itself can say on the console, none of which is a defect
 * in anyone's generated code.
 *
 * The document `lib/preview/html.ts` builds is not the user's page alone: it carries an
 * esm.sh import map (`lib/preview/deps.ts`), a `cdn.tailwindcss.com` script tag, the
 * `__preview/next-*` shims `lib/preview/assemble.ts` aliases `next/link`, `next/image` and
 * `next/navigation` onto, the `__preview*` bridge globals, and a CSP
 * (`lib/preview/headers.ts`) that allows exactly two script hosts. Every one of those can
 * fail without the generated code being wrong — an offline or proxied build box loses both
 * CDNs at once, and Chromium then logs a console error per lost request plus a module
 * resolution failure per import-map entry.
 *
 * Filed as findings, those are the exact failure `browserUnavailableFinding()` exists to
 * avoid: a row on the user's Quality panel that reads as "your site is broken", about our
 * harness, that nothing they can write will ever make go away. So the filter is deliberately
 * aggressive in the direction of dropping a real defect rather than inventing one — a
 * runtime error the user never hears about costs them the status quo, and a fabricated one
 * costs them an afternoon.
 */
/**
 * Noise the *frame* produces, matched against a message's own text.
 *
 * These read as sentences about the harness: a module that would not resolve, the Play CDN
 * or a Google Font that did not arrive, the preview host's CSP talking about the document it
 * serves. Every one of them names its subject in the text, which is why matching the text is
 * enough — and why matching the stack frame instead would be catastrophic, see below.
 */
/**
 * The injected shims and the bridge globals, by path and by the identifier prefix they share.
 *
 * Checked against both a message's text and its stack frame: `window.__previewNavigate is not
 * a function` names the harness in its text with no frame at all, while a throw inside
 * `__preview/next-navigation.ts` names it only in the frame.
 */
const SHIM_NOISE: RegExp[] = [/\/__preview\//, /__preview[A-Za-z-]/];

const HARNESS_TEXT_NOISE: RegExp[] = [
  ...SHIM_NOISE,
  // The import map and anything that failed to resolve through it.
  /esm\.sh/,
  /failed to resolve module specifier/i,
  /failed to (?:fetch|load) (?:dynamically imported )?module/i,
  /importing a module script failed/i,
  /error resolving module specifier/i,
  // The Play CDN and the fonts the design briefs import.
  /cdn\.tailwindcss\.com/,
  /fonts\.(?:googleapis|gstatic)\.com/,
  // The preview host's own Content-Security-Policy speaking about the document it serves.
  /content security policy/i,
  /^refused to /i,
  // Chromium's line for a subresource that did not arrive. On this document most of them
  // are the harness's own third-party fetches; the rest — a missing image in the generated
  // markup — are a network fact rather than a runtime error, and would be filed under a
  // title that lies about them.
  /^failed to load resource/i,
];

/**
 * Noise identified by *where* it was thrown.
 *
 * Deliberately only `SHIM_NOISE`. It must never contain a CDN host, because of what the
 * preview actually is: `buildStaticSite` marks every bare specifier `external` and the served
 * document resolves them through the esm.sh import map, so React, react-dom and every package
 * the model imported are esm.sh modules at runtime. An exception thrown *inside* React
 * therefore carries an esm.sh stack frame — and matching the host against the frame drops
 * "Objects are not valid as a React child", "Rendered more hooks than during the previous
 * render", "Minified React error #185" and every lucide-react throw as harness noise,
 * reporting a page that crashed on mount as having run clean. That is the majority of the
 * class this module exists to catch, which is why the host patterns above are text-only.
 */
const HARNESS_SOURCE_NOISE: RegExp[] = SHIM_NOISE;

export function isPreviewHarnessNoise(message: RuntimeMessage): boolean {
  if (HARNESS_TEXT_NOISE.some((pattern) => pattern.test(message.text))) return true;
  const source = message.source ?? '';
  return source !== '' && HARNESS_SOURCE_NOISE.some((pattern) => pattern.test(source));
}

/** djb2, unsigned, base36 — a short suffix that makes two different messages two different ids. */
function stableHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * The id this message will carry on every future scan that sees it again.
 *
 * Derived from the normalised message and its first stack frame, never from the arrival
 * order or the clock. Ids are the audit's identity for a finding everywhere it matters:
 * `mergeIgnoredFindings` carries an Ignore forward by id, the two viewport passes are
 * deduped by id in `runA11yAudit`, and `groupRecurringIssues` counts rows across the last
 * 200 audits. An id containing a timestamp or an index would make one unchanged defect look
 * like a new one on every scan, which is both an Ignore that never sticks and a recurring
 * -issues panel measuring the scan rate instead of the code.
 *
 * The slug is kept readable, and the hash of the full text is appended so two long messages
 * sharing a prefix — the same TypeError on two different properties — do not collide once
 * the slug is truncated.
 */
export function runtimeFindingId(message: RuntimeMessage): string {
  const normalised = normaliseRuntimeText(message.text);
  const slug = normalised
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `runtime:${slug || 'error'}:${stableHash(`${normaliseSource(message.source) ?? ''}|${normalised}`)}`;
}

function runtimeFinding(message: RuntimeMessage): CodeFinding {
  const normalised = normaliseRuntimeText(message.text);
  const source = normaliseSource(message.source);
  const where = source ? ` Reported from ${source}.` : '';
  return finding({
    id: runtimeFindingId(message),
    category: 'runtime',
    // Advisory, not blocking. The bundle is minified with no source map, so this row can
    // name the message and nothing else — no file, no line — and a severity that outranks
    // an axe violation on evidence that thin would be a claim the audit cannot support.
    // The reader learns their page throws; where it throws is the next round's problem.
    status: 'low',
    title:
      message.kind === 'exception'
        ? 'Your page threw an error in the browser'
        : 'Your page logged an error in the browser',
    detail:
      `${normalised}${where} This happened while the page was loading, which is why the build ` +
      'and the import checks did not catch it — they read the code, not the running site.',
    // Nothing for the Fix action to hand the model but the message itself: with no source
    // map there is no file or line to point it at, and a fix request built from a minified
    // string is a guess. The row is here to tell the reader their page is failing.
    fixable: false,
  });
}

/**
 * The row that says the browser opened the page and it came up.
 *
 * It exists so that "the page ran clean" is a statement in the findings rather than an
 * absence, for the same reason `a11yNeedsScanFinding` exists: a check that never started
 * and a page with no runtime errors both contribute zero defect rows, and only a row can
 * tell them apart. `runCodeScan` reads it as the proof that the browser actually loaded
 * before it counts this check in `checksRun` — the axe pass reaching a verdict is a
 * different fact, and one of the two can be true without the other.
 */
export function runtimeCleanFinding(): CodeFinding {
  return finding({
    id: 'runtime:clean',
    category: 'runtime',
    status: 'pass',
    title: 'Your page ran without errors',
    detail:
      'The audit opened your site in a browser and the page mounted with nothing thrown and nothing logged as an error.',
    fixable: false,
  });
}

/**
 * The findings for one browser pass: the real errors, or the clean row when there were none.
 *
 * Never empty — an empty array is what a page nobody opened also produces.
 */
export function runtimeFindings(messages: RuntimeMessage[]): CodeFinding[] {
  const byId = new Map<string, CodeFinding>();
  for (const message of messages) {
    if (!message.text.trim()) continue;
    if (isPreviewHarnessNoise(message)) continue;
    const row = runtimeFinding(message);
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  if (byId.size === 0) return [runtimeCleanFinding()];
  return [...byId.values()];
}

export type RuntimeCapture = {
  /** Everything captured so far, capped at {@link RUNTIME_MESSAGE_LIMIT}. */
  messages: () => RuntimeMessage[];
};

/**
 * Attaches the two listeners to a page. Must be called before the `goto`, or the load
 * itself — which is when a mount error happens — is over before anyone is listening.
 *
 * Both handlers are synchronous and swallow nothing: a throw inside a Playwright event
 * handler surfaces as an unhandled rejection in the serving process, so they do no work
 * that can fail beyond reading strings off the event.
 *
 * The two listeners do not overlap, and this was measured rather than assumed — the unit
 * tests drive a fake page, so nothing in them could have caught it. Against a real Chromium
 * (Playwright 1.62) a single uncaught `throw` arrives exactly once, on `pageerror`; it never
 * also appears on `console`. `console` carries only explicit console API calls, and the
 * `type() === 'error'` filter below drops `warn` and `log`. Had that been wrong, one throw
 * would have been filed twice under two different ids — once as an exception, once as a
 * console error — and `groupRecurringIssues` would have double-counted every crash.
 */
export function captureRuntimeMessages(page: Page): RuntimeCapture {
  const collected: RuntimeMessage[] = [];
  const push = (message: RuntimeMessage) => {
    if (collected.length >= RUNTIME_MESSAGE_LIMIT) return;
    collected.push(message);
  };

  page.on('pageerror', (error: Error) => {
    // Playwright's wording for this differs by version: some builds put the error class in
    // `name` and the bare text in `message`, others repeat the class inside `message`. The
    // prefix test keeps "TypeError: TypeError: …" out of the finding title either way.
    const text =
      error.name && !error.message.startsWith(error.name)
        ? `${error.name}: ${error.message}`
        : error.message || String(error);
    const frame = error.stack?.match(URL_PATTERN)?.[0];
    push({ kind: 'exception', text, source: frame ? scrubLocation(frame) : null });
  });

  page.on('console', (message: ConsoleMessage) => {
    // Only `error`. The Play CDN warns on every load that it is not for production, React
    // warns about keys, and a generated site is entitled to `console.log` whatever it likes
    // — none of that is a defect, and all of it would arrive here.
    if (message.type() !== 'error') return;
    const url = message.location()?.url;
    push({ kind: 'console', text: message.text(), source: url ? scrubLocation(url) : null });
  });

  return { messages: () => [...collected] };
}
