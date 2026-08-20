import { describe, expect, it } from 'vitest';
import {
  currentRelease,
  parseReleaseHistory,
  previousRelease,
  pushReleaseHistory,
} from '../../lib/deploy/release';
import {
  coolifyApplicationPath,
  coolifyRedeployPath,
  executeCoolifyRollback,
  planRollback,
  ROLLBACK_CONFIRM_PHRASE,
} from '../../lib/deploy/rollback';

describe('release history', () => {
  it('keeps the last ten shas and finds the previous release', () => {
    let history = pushReleaseHistory([], { sha: 'aaa', deployedAt: '2026-08-01T00:00:00.000Z' });
    for (let i = 0; i < 12; i += 1) {
      history = pushReleaseHistory(history, {
        sha: `sha${i}`,
        deployedAt: `2026-08-0${(i % 9) + 1}T00:00:00.000Z`,
      });
    }
    expect(history).toHaveLength(10);
    expect(previousRelease(history, history[0].sha)?.sha).toBe(history[1].sha);
  });

  it('reads GIT_SHA from env', () => {
    expect(currentRelease({ GIT_SHA: 'deadbeef' }).sha).toBe('deadbeef');
  });

  it('falls back through SOURCE_COMMIT, Coolify name, then unknown', () => {
    expect(currentRelease({ SOURCE_COMMIT: 'from-source' }).sha).toBe('from-source');
    expect(currentRelease({ COOLIFY_CONTAINER_NAME: 'navroop-abc' }).sha).toBe('navroop-abc');
    expect(currentRelease({}).sha).toBe('unknown');
    expect(currentRelease({ DEPLOYED_AT: '2026-08-18T00:00:00.000Z' }).deployedAt).toBe(
      '2026-08-18T00:00:00.000Z',
    );
  });

  it('parses stored history and drops invalid rows', () => {
    expect(parseReleaseHistory(null)).toEqual([]);
    expect(parseReleaseHistory(undefined)).toEqual([]);
    expect(parseReleaseHistory('not-json')).toEqual([]);
    expect(parseReleaseHistory('{"sha":"x"}')).toEqual([]);
    expect(
      parseReleaseHistory(
        JSON.stringify([
          { sha: 'keep', deployedAt: '2026-08-01T00:00:00.000Z' },
          { sha: 1, deployedAt: '2026-08-01T00:00:00.000Z' },
          null,
        ]),
      ),
    ).toEqual([{ sha: 'keep', deployedAt: '2026-08-01T00:00:00.000Z' }]);
  });

  it('uses the second history row when the current sha is unknown', () => {
    const history = [
      { sha: 'a', deployedAt: '2026-08-02T00:00:00.000Z' },
      { sha: 'b', deployedAt: '2026-08-01T00:00:00.000Z' },
    ];
    expect(previousRelease(history, 'missing')?.sha).toBe('b');
    expect(previousRelease([history[0]], history[0].sha)).toBeNull();
  });
});

describe('rollback confirmation', () => {
  const history = [
    { sha: 'new', deployedAt: '2026-08-17T00:00:00.000Z' },
    { sha: 'old', deployedAt: '2026-08-16T00:00:00.000Z' },
  ];

  it('requires the typed phrase', () => {
    const refused = planRollback({
      currentSha: 'new',
      confirmation: 'yes',
      history,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain(ROLLBACK_CONFIRM_PHRASE);
  });

  it('selects the previous release', () => {
    const plan = planRollback({
      currentSha: 'new',
      confirmation: ROLLBACK_CONFIRM_PHRASE,
      history,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.target.sha).toBe('old');
  });

  it('accepts a trimmed confirmation and an explicit target sha', () => {
    const plan = planRollback({
      currentSha: 'new',
      targetSha: 'old',
      confirmation: `  ${ROLLBACK_CONFIRM_PHRASE.toUpperCase()}  `,
      history,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.target.sha).toBe('old');
  });

  it('refuses a missing target, an unknown sha, and rolling back to the current sha', () => {
    expect(
      planRollback({
        currentSha: 'only',
        confirmation: ROLLBACK_CONFIRM_PHRASE,
        history: [{ sha: 'only', deployedAt: '2026-08-17T00:00:00.000Z' }],
      }),
    ).toEqual({ ok: false, error: 'No previous release is available' });

    expect(
      planRollback({
        currentSha: 'new',
        targetSha: 'ghost',
        confirmation: ROLLBACK_CONFIRM_PHRASE,
        history,
      }),
    ).toEqual({ ok: false, error: 'No previous release is available' });

    expect(
      planRollback({
        currentSha: 'new',
        targetSha: 'new',
        confirmation: ROLLBACK_CONFIRM_PHRASE,
        history,
      }),
    ).toEqual({ ok: false, error: 'Already on this release' });
  });
});

/**
 * The rollback used to `GET /api/v1/deploy?uuid=…&force=true` — Coolify's *redeploy the
 * current configuration* endpoint — and pass the wanted release as an invented
 * `X-Navroop-Image-Tag` header that Coolify has no code to read. So the button redeployed
 * the broken release and printed "Rollback requested to <sha>": a false success at the
 * one moment an operator most needs the truth.
 *
 * The real lever is the application's `git_commit_sha` (Coolify resolves a manual deploy
 * to it when no commit is given). So: pin it, read it back, and only then deploy — and
 * refuse, having deployed nothing, whenever the pin cannot be proven.
 */
describe('Coolify rollback request', () => {
  type Call = { path: string; method: string; body: string | null };

  function recorder(responses: (call: Call) => Response): {
    request: (path: string, init?: RequestInit) => Promise<Response>;
    calls: Call[];
  } {
    const calls: Call[] = [];
    return {
      calls,
      async request(path, init) {
        const call = {
          path,
          method: init?.method ?? 'GET',
          body: typeof init?.body === 'string' ? init.body : null,
        };
        calls.push(call);
        return responses(call);
      },
    };
  }

  const OLD = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const NEW = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';

  it('builds the application and force-redeploy paths', () => {
    expect(coolifyApplicationPath('app/1')).toBe('/api/v1/applications/app%2F1');
    expect(coolifyRedeployPath('app/1')).toBe('/api/v1/deploy?uuid=app%2F1&force=true');
  });

  it('pins the commit, verifies it, then deploys — in that order', async () => {
    const { request, calls } = recorder((call) => {
      if (call.method === 'PATCH') return Response.json({ message: 'Application updated.' });
      if (call.path === '/api/v1/applications/app-1') {
        return Response.json({ uuid: 'app-1', git_commit_sha: OLD });
      }
      return Response.json({ deployment_uuid: 'dep-77' });
    });

    await expect(
      executeCoolifyRollback({ request, applicationUuid: 'app-1', targetSha: OLD }),
    ).resolves.toEqual({ ok: true, sha: OLD, deploymentUuid: 'dep-77' });

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'PATCH /api/v1/applications/app-1',
      'GET /api/v1/applications/app-1',
      'GET /api/v1/deploy?uuid=app-1&force=true',
    ]);
    // The commit travels in the body Coolify documents, not in a header it ignores.
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ git_commit_sha: OLD });
  });

  it('deploys nothing when Coolify refuses the commit pin', async () => {
    const { request, calls } = recorder((call) =>
      call.method === 'PATCH' ? new Response('nope', { status: 422 }) : Response.json({}),
    );

    await expect(
      executeCoolifyRollback({ request, applicationUuid: 'app-1', targetSha: OLD }),
    ).resolves.toEqual({
      ok: false,
      error:
        'Coolify refused to pin this application to a previous commit (422). Nothing was deployed.',
    });
    // The whole point: no deploy call, so the broken release is not redeployed under the
    // word "rollback".
    expect(calls.map((call) => call.method)).toEqual(['PATCH']);
  });

  it('deploys nothing when the application reads back a different commit', async () => {
    const { request, calls } = recorder((call) =>
      call.method === 'PATCH'
        ? Response.json({ message: 'Application updated.' })
        : Response.json({ git_commit_sha: NEW }),
    );

    await expect(
      executeCoolifyRollback({ request, applicationUuid: 'app-1', targetSha: OLD }),
    ).resolves.toEqual({
      ok: false,
      error: `Coolify still reports commit ${NEW} for this application, so the rollback was not applied. Nothing was deployed.`,
    });
    expect(calls).toHaveLength(2);
  });

  it('says the application is pinned but undeployed when the deploy call fails', async () => {
    const { request } = recorder((call) => {
      if (call.method === 'PATCH') return Response.json({ message: 'Application updated.' });
      if (call.path === '/api/v1/applications/app-1') return Response.json({ git_commit_sha: OLD });
      return new Response('busy', { status: 503 });
    });

    await expect(
      executeCoolifyRollback({ request, applicationUuid: 'app-1', targetSha: OLD }),
    ).resolves.toEqual({
      ok: false,
      error: `Coolify is pinned to ${OLD} but the deploy request failed (503). Deploy the application from Coolify to finish the rollback.`,
    });
  });

  it('succeeds without a deployment id rather than inventing one', async () => {
    const { request } = recorder((call) =>
      call.method === 'PATCH'
        ? Response.json({ message: 'Application updated.' })
        : call.path === '/api/v1/applications/app-1'
          ? Response.json({ git_commit_sha: OLD })
          : Response.json({ message: 'Deployment request queued.' }),
    );

    await expect(
      executeCoolifyRollback({ request, applicationUuid: 'app-1', targetSha: OLD }),
    ).resolves.toEqual({ ok: true, sha: OLD, deploymentUuid: null });
  });
});
