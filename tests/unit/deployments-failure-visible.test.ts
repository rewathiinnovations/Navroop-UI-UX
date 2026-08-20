import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NO_FAILURE_REASON_RECORDED } from '@/lib/publish/failure-copy';
import type { PublicDeployment } from '@/lib/publish/types';

// react-toastify needs a document; nothing here toasts.
vi.mock('@/lib/notify', () => ({
  notify: { loading: vi.fn(), settle: vi.fn(), error: vi.fn() },
  toMessage: (cause: unknown, fallback: string) => fallback,
}));

const { default: DeploymentsList } = await import('@/app/(app)/deployments/DeploymentsList.tsx');

/**
 * `/deployments` shows why a deployment failed (F-260).
 *
 * `lastError`, `progressStep` and `buildLogUrl` were all serialised into this table's props
 * and none of them was rendered: the row said "Failed" beside Stop / Redeploy / Delete, so
 * the user's only move was to press Redeploy and hope. The Coolify application link has been
 * computed and stored since the publish path was written — this asserts the table actually
 * puts it in front of the person who needs it.
 */

const ROW: PublicDeployment = {
  id: 'dep_1',
  projectId: 'proj_1',
  workspaceId: 'ws_1',
  kind: 'LIVE',
  status: 'FAILED',
  slug: 'client-shop',
  url: null,
  expectedUrl: 'https://client-shop.navroop.test',
  canonicalUrl: 'https://client-shop.navroop.test',
  progressStep: 'poll',
  lastError: 'Coolify build exited with code 1',
  lastRequestId: 'req-42',
  buildLogUrl: 'https://coolify.example.test/application/app-1',
  publishedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  hasPassword: false,
  publishedBy: { id: 'user_1', name: 'Ada' },
  projectName: 'Client shop',
};

const render = (rows: PublicDeployment[]) =>
  renderToStaticMarkup(createElement(DeploymentsList, { initial: rows }));

describe('DeploymentsList', () => {
  it('renders the reason, the step and the build log for a failed deployment', () => {
    const html = render([ROW]);

    expect(html).toContain('Coolify build exited with code 1');
    expect(html).toContain('Failed at Build in progress');
    expect(html).toContain('https://coolify.example.test/application/app-1');
    expect(html).toContain('req-42');
  });

  it('says a reason is missing rather than rendering an empty block', () => {
    const html = render([{ ...ROW, lastError: null }]);

    expect(html).toContain(NO_FAILURE_REASON_RECORDED);
  });

  it('does not resurface a stale error under a live site', () => {
    const html = render([{ ...ROW, status: 'LIVE', url: 'https://client-shop.navroop.test' }]);

    expect(html).not.toContain('Coolify build exited with code 1');
    expect(html).not.toContain('View build log');
  });

  it('does not report a failure for a deployment the user stopped', () => {
    expect(render([{ ...ROW, status: 'STOPPED' }])).not.toContain('View build log');
  });
});
