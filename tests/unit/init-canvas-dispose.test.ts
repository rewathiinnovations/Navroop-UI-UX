import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { bindResizeListeners } from '@/utils/init-canvas';

/**
 * F-423. `initCanvas` registered `resize` on `window` and on
 * `window.visualViewport` and returned only the 2D context, so no caller could
 * ever unregister them. Every mount of an endpoints section left two permanent
 * listeners holding a detached canvas and its context alive — twice per mount
 * under StrictMode — and every later resize re-upscaled dead canvases. The
 * lodash `debounce` wrapping the upscale was never cancelled either, so a run
 * already armed fired after unmount.
 *
 * Two halves have to hold: the teardown must actually undo the registration
 * (`bindResizeListeners`, pure enough to drive directly), and every call site
 * must run it on unmount. The second half lives in `useEffect` cleanups, and
 * there is no DOM testing library here, so it is asserted by reading the
 * sources: a `dispose` that is destructured and never invoked is exactly the
 * half-finished state this test exists to catch.
 */

/** A `Pick<EventTarget, 'addEventListener' | 'removeEventListener'>` that records. */
function recordingTarget() {
  const added: string[] = [];
  const removed: string[] = [];
  return {
    added,
    removed,
    addEventListener: (type: string) => {
      added.push(type);
    },
    removeEventListener: (type: string) => {
      removed.push(type);
    },
  };
}

describe('bindResizeListeners', () => {
  it('registers resize on every present target and removes both on dispose', () => {
    const win = recordingTarget();
    const viewport = recordingTarget();
    const handler = () => {};

    const dispose = bindResizeListeners([win, viewport], handler);

    expect(win.added).toEqual(['resize']);
    expect(viewport.added).toEqual(['resize']);
    expect(win.removed).toEqual([]);

    dispose();

    expect(win.removed).toEqual(['resize']);
    expect(viewport.removed).toEqual(['resize']);
  });

  it('skips an absent visualViewport instead of throwing', () => {
    const win = recordingTarget();
    const dispose = bindResizeListeners([win, undefined, null], () => {});
    expect(() => dispose()).not.toThrow();
    expect(win.removed).toEqual(['resize']);
  });

  it('cancels a debounced handler so an armed upscale cannot fire after unmount', () => {
    const handler = Object.assign(() => {}, { cancel: vi.fn() });
    bindResizeListeners([recordingTarget()], handler)();
    expect(handler.cancel).toHaveBeenCalledTimes(1);
  });

  it('is idempotent, so a double cleanup neither double-removes nor double-cancels', () => {
    const win = recordingTarget();
    const handler = Object.assign(() => {}, { cancel: vi.fn() });
    const dispose = bindResizeListeners([win], handler);

    dispose();
    dispose();

    expect(win.removed).toEqual(['resize']);
    expect(handler.cancel).toHaveBeenCalledTimes(1);
  });
});

/**
 * Every module that pulls a `dispose` out of `initCanvas`. Listed explicitly so
 * a new canvas section has to be added here deliberately rather than slipping
 * in unchecked.
 */
const CANVAS_CONSUMERS = [
  'components/app/(home)/sections/endpoints/EndpointsCrawl/EndpointsCrawl.tsx',
  'components/app/(home)/sections/endpoints/EndpointsExtract/EndpointsExtract.tsx',
  'components/app/(home)/sections/endpoints/EndpointsScrape/EndpointsScrape.tsx',
  'components/app/(home)/sections/endpoints/EndpointsSearch/EndpointsSearch.tsx',
  'components/app/(home)/sections/endpoints/Extract/Extract.tsx',
  'components/app/(home)/sections/endpoints/Mcp/Mcp.tsx',
];

describe('every initCanvas call site runs the teardown', () => {
  it.each(CANVAS_CONSUMERS)('%s destructures dispose and returns it from the effect', (path) => {
    const source = readFileSync(path, 'utf8');

    expect(source).toContain('initCanvas');
    expect(source).toMatch(/const \{ ctx, dispose \} = initCanvas\(/);

    // The whole point: the effect must hand `dispose` back to React. Either
    // shape counts — `return dispose` on the plain path, or `dispose()` inside
    // a cleanup that also unbinds hover listeners.
    expect(source).toMatch(/return dispose;|dispose\(\);/);
  });

  /**
   * The regression. Four of these six destructured `dispose` and never called
   * it: the listeners still leaked, and the binding was dead. An effect whose
   * only mention of `dispose` is the destructuring is that bug.
   */
  it.each(CANVAS_CONSUMERS)('%s does not leave dispose unused', (path) => {
    const source = readFileSync(path, 'utf8');
    const mentions = source.match(/\bdispose\b/g) ?? [];
    expect(mentions.length).toBeGreaterThan(1);
  });
});
