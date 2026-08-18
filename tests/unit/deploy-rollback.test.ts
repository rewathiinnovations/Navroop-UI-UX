import { describe, expect, it } from 'vitest';
import {
  currentRelease,
  parseReleaseHistory,
  previousRelease,
  pushReleaseHistory,
} from '../../lib/deploy/release';
import {
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

describe('Coolify rollback request', () => {
  it('builds the force-redeploy path', () => {
    expect(coolifyRedeployPath('app/1')).toBe('/api/v1/deploy?uuid=app%2F1&force=true');
  });

  it('sends the image tag header and treats a 2xx as success', async () => {
    const request = async (path: string, init?: RequestInit) => {
      expect(path).toBe('/api/v1/deploy?uuid=app-1&force=true');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toEqual({ 'X-Navroop-Image-Tag': 'sha-old' });
      return new Response('ok', { status: 200 });
    };
    await expect(
      executeCoolifyRollback({ request, applicationUuid: 'app-1', imageTag: 'sha-old' }),
    ).resolves.toEqual({ ok: true });
  });

  it('returns the Coolify status when redeploy fails', async () => {
    const request = async () => new Response('busy', { status: 503 });
    await expect(
      executeCoolifyRollback({
        request,
        applicationUuid: 'app-1',
        imageTag: 'sha-old',
      }),
    ).resolves.toEqual({ ok: false, error: 'Coolify rollback returned 503' });
  });
});
