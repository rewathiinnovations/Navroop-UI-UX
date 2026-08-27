import { describe, expect, it } from 'vitest';
import { buildPreviewSrcdoc } from '@/lib/preview/html';

/**
 * BrowserPreview only disarms its 15 second watchdog on the frame's "ready"
 * postMessage, so a raw-HTML preview that never gets the ready script is
 * covered by "The preview did not finish loading" even though it rendered.
 * The injection used to be a `.replace(/<\/body>/i, …)`, which returns the
 * input unchanged when it matches nothing — the failure was invisible because
 * a no-op replace looks exactly like a success. Every markup shape must come
 * back carrying both the error bridge and the ready signal.
 */
describe('raw-HTML preview injection', () => {
  const ready = '{ type: "ready" }';
  const bridge = 'window.__previewPost = POST';

  it('injects both scripts into a complete document', () => {
    const srcdoc = buildPreviewSrcdoc({
      code: '',
      rawHtml: '<html><head><title>Site</title></head><body><h1>Hi</h1></body></html>',
    });
    expect(srcdoc).toContain(bridge);
    expect(srcdoc).toContain(ready);
    // The bridge has to be in place before any of the page's own scripts run.
    expect(srcdoc.indexOf(bridge)).toBeLessThan(srcdoc.indexOf('<h1>Hi</h1>'));
    expect(srcdoc.indexOf(ready)).toBeLessThan(srcdoc.indexOf('</body>'));
  });

  it('still signals ready when the markup has a <head> but no </body>', () => {
    const srcdoc = buildPreviewSrcdoc({
      code: '',
      rawHtml: '<html><head><title>Site</title></head><body><h1>Hi</h1>',
    });
    expect(srcdoc).toContain(bridge);
    expect(srcdoc).toContain(ready);
  });

  it('still signals ready for a fragment with neither <head> nor </body>', () => {
    const srcdoc = buildPreviewSrcdoc({ code: '', rawHtml: '<h1>Hi</h1>' });
    expect(srcdoc).toContain(bridge);
    expect(srcdoc).toContain(ready);
    expect(srcdoc.indexOf(bridge)).toBeLessThan(srcdoc.indexOf('<h1>Hi</h1>'));
  });

  it('signals ready for an uppercase </BODY>, which the old replace also matched', () => {
    const srcdoc = buildPreviewSrcdoc({
      code: '',
      rawHtml: '<HTML><HEAD></HEAD><BODY><h1>Hi</h1></BODY></HTML>',
    });
    expect(srcdoc).toContain(bridge);
    expect(srcdoc).toContain(ready);
    expect(srcdoc.indexOf(ready)).toBeLessThan(srcdoc.indexOf('</BODY>'));
  });
});

/** The body of the first inline `<script>…</script>` that mentions `needle`. */
function inlineScriptContaining(srcdoc: string, needle: string): string {
  for (const part of srcdoc.split('<script>').slice(1)) {
    const end = part.indexOf('</script>');
    const body = end === -1 ? part : part.slice(0, end);
    if (body.includes(needle)) return body;
  }
  throw new Error(`no inline script in the srcdoc contains ${needle}`);
}

/**
 * The Tailwind Play CDN is a third-party origin the frame is allowed to lose: an
 * offline dev machine, a corporate proxy, or a CSP on the preview host. Losing it
 * used to mean unstyled output. Then the frame started configuring the CDN with a
 * bare `tailwind.config = {…}` immediately after the `<script src>` and before the
 * error bridge, so a blocked CDN threw `ReferenceError: tailwind is not defined`
 * with no listener installed to catch it — and the iframe is sandboxed without
 * allow-same-origin, so the pane could not see it either. A missing stylesheet
 * became an unreportable failure.
 */
describe('a blocked Tailwind CDN stays a styling problem', () => {
  const srcdoc = buildPreviewSrcdoc({ code: 'void 0;', css: 'body{}' });
  const configScript = inlineScriptContaining(srcdoc, 'tailwind.config');

  it('does not throw when the CDN never defined `tailwind`', () => {
    // Exactly the frame's situation: the global is absent, not falsy.
    expect(() => new Function(configScript)()).not.toThrow();
  });

  it('still configures the CDN when it did load', () => {
    const applied = new Function(
      'tailwind',
      `${configScript}\nreturn tailwind.config;`,
    )({}) as { darkMode?: string; theme?: unknown } | null;
    expect(applied?.darkMode).toBe('class');
    expect(applied?.theme).toBeTruthy();
  });

  it('installs the error bridge before anything that can throw', () => {
    const bridgeAt = srcdoc.indexOf('window.__previewPost = POST');
    expect(bridgeAt).toBeGreaterThan(-1);
    expect(bridgeAt).toBeLessThan(srcdoc.indexOf('cdn.tailwindcss.com'));
    expect(bridgeAt).toBeLessThan(srcdoc.indexOf('tailwind.config'));
    expect(bridgeAt).toBeLessThan(srcdoc.indexOf('id="__preview-app"'));
  });
});
