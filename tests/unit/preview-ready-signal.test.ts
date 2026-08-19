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
