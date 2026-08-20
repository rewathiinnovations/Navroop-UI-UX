import { debounce } from 'lodash-es';

/** The part of `EventTarget` this module uses. `window.visualViewport` may be absent. */
type ResizeTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** A handler that may carry a `cancel`, as lodash's `debounce` result does. */
type CancellableHandler = (() => void) & { cancel?: () => void };

/**
 * Registers `handler` for `resize` on every present target and returns the
 * teardown.
 *
 * `initCanvas` used to add these two listeners and return only the 2D context,
 * so no caller could unregister them even if it wanted to: every mount of an
 * endpoints section left two permanent listeners holding a detached canvas and
 * its context alive, and every subsequent resize re-upscaled dead canvases.
 * StrictMode mounts each of them twice in development, so the list grew two at a
 * time. The debounce was never cancelled either, which is why the teardown calls
 * `cancel` — a run already armed would otherwise still fire after the removal.
 *
 * Separate from `initCanvas` because that one needs a real `<canvas>` and a
 * layout engine; this is the half that has to be right, and it is testable.
 */
export function bindResizeListeners(
  targets: readonly (ResizeTarget | null | undefined)[],
  handler: CancellableHandler,
): () => void {
  const bound = targets.filter((target): target is ResizeTarget => Boolean(target));

  for (const target of bound) target.addEventListener('resize', handler);

  let disposed = false;
  return () => {
    // Idempotent: React may call an effect cleanup once, and a caller that also
    // disposes on an error path must not double-remove or double-cancel.
    if (disposed) return;
    disposed = true;
    for (const target of bound) target.removeEventListener('resize', handler);
    handler.cancel?.();
  };
}

export type Canvas2D = {
  ctx: CanvasRenderingContext2D;
  /** Removes the resize listeners and drops any pending upscale. Call on unmount. */
  dispose: () => void;
};

const initCanvas = (canvas: HTMLCanvasElement): Canvas2D => {
  const { width, height } = canvas.getBoundingClientRect();
  const ctx = canvas.getContext('2d')!;

  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const upscaleCanvas = () => {
    const scale = window.visualViewport?.scale || 1;
    const dpr = (window.devicePixelRatio || 1) * scale;

    canvas.width = width * dpr;
    canvas.height = height * dpr;

    ctx.scale(dpr, dpr);

    canvas.dispatchEvent(new Event('resize'));
  };

  upscaleCanvas();

  const handleResize = debounce(upscaleCanvas, 500);

  return {
    ctx,
    dispose: bindResizeListeners([window, window.visualViewport], handleResize),
  };
};

export default initCanvas;
