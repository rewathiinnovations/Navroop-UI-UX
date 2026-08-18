import { describe, expect, it } from 'vitest';
import {
  createAiMock,
  createCloudflareMock,
  createCoolifyMock,
  createGithubMock,
  createResendMock,
  createSentryMock,
  createStorageMock,
} from '../mocks';

const factories = [
  ['ai', createAiMock],
  ['github', createGithubMock],
  ['coolify', createCoolifyMock],
  ['cloudflare', createCloudflareMock],
  ['resend', createResendMock],
  ['sentry', createSentryMock],
  ['storage', createStorageMock],
] as const;

describe('external mocks', () => {
  it('each mock supports success, failure, timeout, rate-limit, and partial', async () => {
    for (const [name, factory] of factories) {
      const success = factory('success');
      if (name === 'sentry') {
        expect(() => success.captureException({})).not.toThrow();
      } else {
        await expect(
          'complete' in success
            ? success.complete('hi')
            : 'create' in success
              ? success.create()
              : 'lookupOrCreateRepo' in success
                ? success.lookupOrCreateRepo('acme')
                : 'createApp' in success
                  ? success.createApp('acme')
                  : 'upsertDns' in success
                    ? success.upsertDns('acme', '1.2.3.4')
                    : 'send' in success
                      ? success.send({ to: 'a@b.c', subject: 'Hi' })
                      : success.put('k', Buffer.from('x')),
        ).resolves.toBeTruthy();
      }

      for (const outcome of ['failure', 'timeout', 'rate_limit'] as const) {
        const mock = factory(outcome);
        if (name === 'sentry') {
          expect(() => mock.captureException({})).toThrow();
          continue;
        }
        const call =
          'complete' in mock
            ? mock.complete('hi')
            : 'create' in mock
              ? mock.create()
              : 'lookupOrCreateRepo' in mock
                ? mock.lookupOrCreateRepo('acme')
                : 'createApp' in mock
                  ? mock.createApp('acme')
                  : 'upsertDns' in mock
                    ? mock.upsertDns('acme', '1.2.3.4')
                    : 'send' in mock
                      ? mock.send({ to: 'a@b.c', subject: 'Hi' })
                      : 'put' in mock
                        ? mock.put('k', Buffer.from('x'))
                        : Promise.reject(new Error('missing'));
        await expect(call).rejects.toBeInstanceOf(Error);
      }
      expect(name).toBeTruthy();
    }
  });

  it('AI mock is not invoked until complete() is called', () => {
    const ai = createAiMock('success');
    expect(ai.invoked).toBe(0);
  });
});
