import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SCREENSHOT_NETWORK_ERROR,
  screenshotErrorMessage,
} from '@/lib/generation/screenshot-error';

/**
 * A server error must not be reported as a network error (F-057).
 *
 * `captureUrlScreenshot` called `response.json()` without checking the status, so
 * a 500 that answered with an HTML error page threw a SyntaxError, landed in the
 * network catch, and told the user "Network error while capturing screenshot" —
 * so they retried a broken endpoint instead of reporting it.
 */

const WORKSPACE = readFileSync('components/workspace/GenerationWorkspace.tsx', 'utf8');

describe('screenshotErrorMessage', () => {
  it('keeps the network line only for a request that never completed', () => {
    expect(screenshotErrorMessage({ status: null, body: null })).toBe(SCREENSHOT_NETWORK_ERROR);
  });

  it('names the status when the server answered with something unreadable', () => {
    // The exact case that used to be misreported: a 500 HTML error page.
    expect(screenshotErrorMessage({ status: 500, body: null })).toBe(
      'Failed to capture screenshot (500)',
    );
    expect(screenshotErrorMessage({ status: 502, body: '<html>Bad gateway</html>' })).toBe(
      'Failed to capture screenshot (502)',
    );
    expect(screenshotErrorMessage({ status: 401, body: {} })).toBe(
      'Failed to capture screenshot (401)',
    );
  });

  it('prefers the server’s own sentence when it sent one', () => {
    expect(
      screenshotErrorMessage({ status: 500, body: { error: 'Firecrawl API key not configured' } }),
    ).toBe('Firecrawl API key not configured');
    expect(screenshotErrorMessage({ status: 400, body: { error: '  URL is required  ' } })).toBe(
      'URL is required',
    );
  });

  it('falls back rather than showing a blank or non-string error field', () => {
    expect(screenshotErrorMessage({ status: 500, body: { error: '   ' } })).toBe(
      'Failed to capture screenshot (500)',
    );
    expect(screenshotErrorMessage({ status: 500, body: { error: { code: 9 } } })).toBe(
      'Failed to capture screenshot (500)',
    );
  });

  it('does not name a 2xx status that simply carried no screenshot', () => {
    expect(screenshotErrorMessage({ status: 200, body: { success: false } })).toBe(
      'Failed to capture screenshot',
    );
  });
});

describe('captureUrlScreenshot wiring', () => {
  it('parses the body defensively and gates success on response.ok', () => {
    expect(WORKSPACE).toMatch(/const data = await response\.json\(\)\.catch\(\(\) => null\)/);
    expect(WORKSPACE).toMatch(/if \(response\.ok && data\?\.success && data\.screenshot\)/);
  });

  it('classifies everything the server answered by status, network only on a throw', () => {
    expect(WORKSPACE).toMatch(
      /screenshotErrorMessage\(\{ status: response\.status, body: data \}\)/,
    );
    expect(WORKSPACE).toMatch(/screenshotErrorMessage\(\{ status: null, body: null \}\)/);
    // The literal must live in the copy module, not inline in the catch.
    expect(WORKSPACE).not.toMatch(/'Network error while capturing screenshot'/);
  });
});
