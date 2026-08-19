import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  bundleFailureState,
  errorBanner,
  previewError,
  PreviewErrorReport,
  settleReducer,
  type PreviewState,
  type SettleTarget,
} from '@/components/workspace/BrowserPreview';
import { explainPreviewError, pendingLocalModules } from '@/lib/preview/labels';
import type { PreviewAssembly } from '@/lib/preview/assemble';

// esbuild-wasm has no business booting for this file: nothing here reaches the
// bundler, because BrowserPreview only calls it from an effect.
vi.mock('@/lib/preview/bundle', () => ({
  bundlePreview: vi.fn(async () => ({ ok: false as const, error: 'not called' })),
}));

/** The failure the user photographed: a named import the model never exported. */
const MISSING_EXPORT =
  'No matching export in "vfs:lib/data.ts" for import "site" (vfs:app/page.tsx:13)';

/** The failure the user photographed mid-stream, at 16 of ~25 files. */
const UNWRITTEN_COMPONENT =
  'Cannot resolve "@/components/FinalCTA" from "app/page.tsx" (vfs:app/page.tsx:5)';

const GOOD: PreviewState = { status: 'ready', srcdoc: '<html>good</html>' };

type ActionProps = {
  'data-preview-action'?: string;
  onClick?: () => void;
  children?: ReactNode;
};

/** Finds one of the report's buttons so its handler can be fired without a DOM. */
function findAction(node: ReactNode, action: string): ActionProps | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findAction(child, action);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  // React element props are `unknown` to the compiler; this walker reads only
  // the two fields the report puts on its own buttons.
  const props = node.props as ActionProps;
  if (props['data-preview-action'] === action) return props;
  return findAction(props.children ?? null, action);
}

function target(key: string): SettleTarget {
  const assembly: PreviewAssembly = { kind: 'bundle', entry: key, files: {}, aliases: {} };
  return { key, assembly };
}

/**
 * The pane showed `No matching export in "vfs:lib/data.ts" for import "site"`
 * and a Try again that recompiled the same broken code. `vfs:` is the namespace
 * of our own esbuild plugin, and the retry could only ever fail again.
 */
describe('preview compile failure is actionable', () => {
  it('says which file imports what from where, without the internal scheme', () => {
    expect(explainPreviewError(MISSING_EXPORT)).toEqual([
      'app/page.tsx imports “site” from lib/data.ts, but lib/data.ts does not export it.',
    ]);
    expect(explainPreviewError(MISSING_EXPORT).join('')).not.toContain('vfs:');
  });

  it('renders the sentence, keeps the compiler text, and offers the repair', () => {
    const markup = renderToStaticMarkup(
      createElement(PreviewErrorReport, {
        message: MISSING_EXPORT,
        kind: 'code',
        onFix: () => {},
        onReload: () => {},
      }),
    );

    expect(markup).toContain(
      'app/page.tsx imports “site” from lib/data.ts, but lib/data.ts does not export it.',
    );
    // Collapsed, not dropped: the compiler's own words stay reachable — minus a
    // namespace that names nothing in the project.
    expect(markup).toContain('Compiler output');
    // React escapes the quotes esbuild puts around the paths.
    expect(markup).toContain('No matching export in &quot;lib/data.ts&quot;');
    expect(markup).not.toContain('vfs:');
    expect(markup).toContain('Fix this');
  });

  it('hands the compiler message and the failure class to the chat', () => {
    const onFix = vi.fn();
    const report = PreviewErrorReport({
      message: MISSING_EXPORT,
      kind: 'code',
      onFix,
      onReload: () => {},
    });

    findAction(report, 'fix')?.onClick?.();
    // Verbatim message, plus the class. The instruction differs by class: a
    // runtime crash compiled fine, so asking the model to make it compile sent it
    // hunting a build error that did not exist, and the crash survived the edit.
    expect(onFix).toHaveBeenCalledWith(MISSING_EXPORT, 'code');
  });

  it('reports a runtime crash as its own class', () => {
    const crash = "Uncaught TypeError: Cannot read properties of undefined (reading 'map')";
    const onFix = vi.fn();
    const report = PreviewErrorReport({
      message: crash,
      kind: 'runtime',
      onFix,
      onReload: () => {},
    });

    findAction(report, 'fix')?.onClick?.();
    expect(onFix).toHaveBeenCalledWith(crash, 'runtime');
  });

  it('does not call recompiling a retry when the code is what is broken', () => {
    const code = renderToStaticMarkup(
      createElement(PreviewErrorReport, {
        message: MISSING_EXPORT,
        kind: 'code',
        onReload: () => {},
      }),
    );
    expect(code).toContain('Recompile');
    expect(code).not.toContain('Try again');
    expect(code).toContain('only helps once the code has changed');

    // A frame that never loaded genuinely can pass on a second attempt.
    const runtime = renderToStaticMarkup(
      createElement(PreviewErrorReport, {
        message: 'The preview did not finish loading.',
        kind: 'runtime',
        onReload: () => {},
      }),
    );
    expect(runtime).toContain('Try again');
    expect(runtime).not.toContain('Recompile');
  });

  it('falls back to the compiler text when it recognises nothing', () => {
    const raw = 'Build failed: Unexpected end of file (app/page.tsx:88)';
    expect(explainPreviewError(raw)).toEqual([]);

    const markup = renderToStaticMarkup(
      createElement(PreviewErrorReport, { message: raw, kind: 'code', onReload: () => {} }),
    );
    expect(markup).toContain('Unexpected end of file');
    // Nothing was understood, so there is no sentence to hide the raw text behind.
    expect(markup).not.toContain('Compiler output');
  });

  it('keeps the last good preview on screen and clears the banner once a compile passes', () => {
    const failed = previewError(GOOD, MISSING_EXPORT, 'code');
    expect(failed).toMatchObject({ status: 'error', srcdoc: GOOD.srcdoc });
    expect(errorBanner(failed)).toEqual({ message: MISSING_EXPORT, kind: 'code' });

    // The compile effect replaces the state wholesale on success.
    expect(errorBanner({ status: 'running', srcdoc: '<html>fixed</html>' })).toBeNull();
  });
});

/**
 * Incident: with 16 of ~25 files streamed, `app/page.tsx` had completed and
 * imported `@/components/FinalCTA`, which the model had not written yet — and
 * the pane told the user their preview was broken while it was still typing.
 */
describe('a half-written build is not a broken one', () => {
  it('waits on a local module the running stream may still write', () => {
    const state = bundleFailureState(GOOD, UNWRITTEN_COMPONENT, true);

    expect(state.status).toBe('waiting');
    expect(errorBanner(state)).toBeNull();
    if (state.status !== 'waiting') throw new Error('expected patience, not an error');
    // Swallowing the failure is only allowed while the pane names the file.
    expect(state.reason).toContain('components/FinalCTA');
    expect(state.reason).not.toContain('Cannot resolve');
    // The last good frame stays up, and the bundler's words are kept so the
    // stream ending can report them verbatim.
    expect(state.srcdoc).toBe(GOOD.srcdoc);
    expect(state.pendingError).toBe(UNWRITTEN_COMPONENT);
  });

  it('reports the same failure once the stream has ended', () => {
    const state = bundleFailureState(GOOD, UNWRITTEN_COMPONENT, false);

    expect(errorBanner(state)).toEqual({ message: UNWRITTEN_COMPONENT, kind: 'code' });
    expect(explainPreviewError(UNWRITTEN_COMPONENT)).toEqual([
      'app/page.tsx imports “@/components/FinalCTA”, but no file with that path was generated.',
    ]);
  });

  it('reports a package immediately, even mid-stream', () => {
    // No amount of further streaming produces an npm package.
    const message = 'Could not resolve "framer-motion-3d" (app/page.tsx:2)';
    expect(pendingLocalModules(message)).toBeNull();
    expect(errorBanner(bundleFailureState(GOOD, message, true))).toEqual({
      message,
      kind: 'code',
    });
  });

  it('reports a mixed failure rather than waiting out the half of it that could arrive', () => {
    const message = `${UNWRITTEN_COMPONENT}\nBuild failed: Unexpected end of file (app/hero.tsx:40)`;
    expect(pendingLocalModules(message)).toBeNull();
    expect(bundleFailureState(GOOD, message, true).status).toBe('error');
  });

  it('names every file it is waiting for', () => {
    const message = [
      UNWRITTEN_COMPONENT,
      'Cannot resolve "./pricing-table" from "app/page.tsx" (vfs:app/page.tsx:6)',
      MISSING_EXPORT,
    ].join('\n');

    expect(pendingLocalModules(message)).toEqual([
      'components/FinalCTA',
      './pricing-table',
      'site in lib/data.ts',
    ]);
  });

  it('recompiles on the next settle window, so an arriving file clears the wait', () => {
    const [half, whole] = [target('16-files'), target('17-files')];
    let scheduled = settleReducer(
      { active: half, pending: null },
      { type: 'files', target: whole, settling: true },
    );
    scheduled = settleReducer(scheduled, { type: 'settled' });
    expect(scheduled.active.key).toBe('17-files');

    // That compile succeeds, which leaves nothing waiting and nothing to report.
    const rendered: PreviewState = { status: 'running', srcdoc: '<html>17 files</html>' };
    expect(rendered.status).toBe('running');
    expect(errorBanner(rendered)).toBeNull();
  });
});
