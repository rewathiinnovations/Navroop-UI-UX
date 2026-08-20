import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deploymentHealthFromStatus,
  getCoolifyDeployment,
  type CoolifyServerAuth,
} from '@/lib/coolify/client';

/**
 * Reading one deployment, not the application.
 *
 * `GET /api/v1/applications/{uuid}` answers "is the application healthy right now", which
 * on every re-publish is yes — the previous release is still serving. The publish poll
 * used that as its success signal, so it broke on the first tick and the job wrote LIVE
 * over a build that had not finished. `GET /api/v1/deployments/{uuid}` is the only
 * endpoint that answers for the build this job triggered.
 */

const SERVER: CoolifyServerAuth = {
  apiUrl: 'https://coolify.example.test',
  apiToken: 'not-a-real-token',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string) => Response) {
  const seen: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL) => {
    seen.push(String(url));
    return handler(String(url));
  });
  return seen;
}

describe('deploymentHealthFromStatus', () => {
  it('treats only "finished" as success', () => {
    expect(deploymentHealthFromStatus('finished')).toBe('healthy');
    expect(deploymentHealthFromStatus('FINISHED')).toBe('healthy');
    expect(deploymentHealthFromStatus(' finished ')).toBe('healthy');
  });

  it('names the terminal failures Coolify reports', () => {
    expect(deploymentHealthFromStatus('failed')).toBe('failed');
    expect(deploymentHealthFromStatus('cancelled-by-user')).toBe('failed');
  });

  it('keeps waiting through the in-flight states, and through words it does not know', () => {
    expect(deploymentHealthFromStatus('queued')).toBe('building');
    expect(deploymentHealthFromStatus('in_progress')).toBe('building');
    expect(deploymentHealthFromStatus('')).toBe('building');
    // A status Coolify adds later must not be read as success by accident — the poll
    // timing out is a failure to verify, which is the honest answer.
    expect(deploymentHealthFromStatus('finishing-up')).toBe('building');
  });
});

describe('getCoolifyDeployment', () => {
  it('reads the deployment resource, not the application', async () => {
    const seen = stubFetch(() => Response.json({ status: 'in_progress' }));

    await expect(getCoolifyDeployment(SERVER, 'dep-1')).resolves.toMatchObject({
      health: 'building',
      status: 'in_progress',
    });
    expect(seen).toEqual(['https://coolify.example.test/api/v1/deployments/dep-1']);
  });

  it('reads a status nested under `data`', async () => {
    stubFetch(() => Response.json({ data: { status: 'finished' } }));

    await expect(getCoolifyDeployment(SERVER, 'dep-1')).resolves.toMatchObject({
      health: 'healthy',
      status: 'finished',
    });
  });

  it('treats a not-yet-visible deployment as still building', async () => {
    // Coolify has been observed not to expose a just-queued deployment. Never becoming
    // `finished` times the poll out, which is a failure to verify — not a pass.
    stubFetch(() => Response.json({ message: 'Deployment not found.' }, { status: 404 }));

    await expect(getCoolifyDeployment(SERVER, 'dep-1')).resolves.toMatchObject({
      health: 'building',
      status: 'not_found',
    });
  });

  it('propagates a real API failure rather than reporting a state', async () => {
    stubFetch(() => Response.json({ message: 'Unauthenticated.' }, { status: 401 }));

    await expect(getCoolifyDeployment(SERVER, 'dep-1')).rejects.toThrow('Unauthenticated.');
  });
});
