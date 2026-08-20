import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The route segments that must carry their own loading, error and not-found states (F-445).
 *
 * The whole `app/` tree had exactly two special files — `app/error.tsx` and
 * `app/global-error.tsx` — for 35 pages. So every async server page blocked on its data with
 * no streamed shell, a bad project id fell through to the framework's unbranded 404, and a
 * throw anywhere under `(app)` or the workspace unmounted the entire chrome and replaced it
 * with the root boundary.
 *
 * This is deliberately a short list rather than one entry per directory: a boundary earns its
 * place where it keeps a frame the user needs (the authenticated shell, the admin rail, the
 * workspace) or where it stands in for content that actually streams.
 *
 * The Sentry assertion is the other half. `app/error.tsx` reports (F-436) precisely because
 * `ErrorId` tells the user to quote the id to support, so support has to be able to look it
 * up. A nested boundary that renders the same id and swallows the exception would make that
 * promise a lie for every error it catches — which is most of them, since the nearest
 * boundary wins.
 */

const REQUIRED = [
  // The authenticated shell: the sidebar and glow live in `(app)/layout.tsx`, so a boundary
  // here keeps navigation alive while one pane is broken or loading.
  'app/(app)/loading.tsx',
  'app/(app)/error.tsx',
  // No `(app)/not-found.tsx`: nothing under `(app)` takes a dynamic segment, so no page
  // there can raise a 404 and the file would never render.
  // Admin is its own frame (rail + content column) and every page is an async dashboard.
  'app/(app)/admin/loading.tsx',
  'app/(app)/admin/error.tsx',
  // The workspace is outside `(app)` and has no sidebar to fall back on. It is also the one
  // route with an id a user can get wrong, so it is where the branded 404 belongs.
  'app/project/[id]/loading.tsx',
  'app/project/[id]/error.tsx',
  'app/project/[id]/not-found.tsx',
  // A URL matching no segment at all, so the 404 is branded instead of the framework default.
  'app/not-found.tsx',
] as const;

const ERROR_BOUNDARIES = REQUIRED.filter((path) => path.endsWith('error.tsx'));

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/**
 * Each `error.tsx` is a thin frame around `components/errors/SegmentError.tsx`, so the
 * reporting assertions have to look at the boundary's graph rather than one file. Following
 * exactly the one delegate keeps the assertion honest: a boundary that stopped rendering it
 * would have to report for itself.
 */
const SEGMENT_ERROR = 'components/errors/SegmentError.tsx';

function boundarySource(path: string) {
  const source = read(path);
  return source.includes('SegmentError') ? `${source}\n${read(SEGMENT_ERROR)}` : source;
}

describe('route segment boundaries', () => {
  it.each(REQUIRED)('%s exists', (path) => {
    expect(existsSync(join(process.cwd(), path))).toBe(true);
  });

  it.each(ERROR_BOUNDARIES)('%s reports to Sentry instead of swallowing', (path) => {
    const source = boundarySource(path);

    expect(source).toMatch(/captureException/);
    // Guards the F-436 fix one level down: the nearest boundary wins, so a nested one that
    // did not report would silently un-instrument most UI errors.
    expect(source).toContain('@sentry/nextjs');
  });

  it.each(ERROR_BOUNDARIES)('%s offers the user a way back', (path) => {
    // A boundary with no retry is a dead end: the segment stays broken until a full reload.
    expect(boundarySource(path)).toMatch(/reset\(\)/);
  });

  it.each(ERROR_BOUNDARIES)('%s shows the id support can look up', (path) => {
    expect(boundarySource(path)).toMatch(/ErrorId/);
  });

  it('gives every boundary its own Sentry scope so the events stay separable', () => {
    const scopes = ERROR_BOUNDARIES.map((path) => /scope="([^"]+)"/.exec(read(path))?.[1]);

    expect(scopes.every(Boolean)).toBe(true);
    expect(new Set(scopes).size).toBe(ERROR_BOUNDARIES.length);
  });

  it.each(REQUIRED.filter((path) => path.endsWith('loading.tsx')))(
    '%s renders a shaped placeholder rather than a spinner or a bare string',
    (path) => {
      const source = read(path);

      expect(source).toMatch(/Skeleton|--studio-skeleton/);
      expect(source).not.toMatch(/Loading…|Loading\.\.\./);
    },
  );

  it.each(REQUIRED.filter((path) => path.endsWith('not-found.tsx')))(
    '%s links the user somewhere they can act',
    (path) => {
      expect(read(path)).toMatch(/\/dashboard/);
    },
  );

  it('raises the workspace 404 instead of rendering the shell against a missing project', () => {
    // Without this the branded page is decorative: the route used to render `GenerationWorkspace`
    // with nulls for a deleted or mistyped id — an empty chat beside an empty preview.
    const source = read('app/project/[id]/page.tsx');

    expect(source).toMatch(/if \(!project\) notFound\(\)/);
  });
});
