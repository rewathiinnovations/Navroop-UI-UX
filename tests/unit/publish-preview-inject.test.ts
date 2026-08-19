import { describe, expect, it } from 'vitest';
import { injectPreviewFiles } from '@/lib/publish/preview-inject';

/**
 * Preview files are injected into the deploy-repo push only. These cases pin the
 * HTML noindex / robots.txt / Next middleware paths that `runPublishJob` hits for
 * PREVIEW but that the execute suite only drives for a Next.js app with no
 * existing config and no password.
 *
 * The gate case used to hand in `password: 'preview-secret'`, which no caller ever did —
 * `runPublishJob` passed a hardcoded `null`, so the assertion stayed green while every real
 * node-stack preview shipped without a gate. The input is now the flag the loop actually
 * derives from `Deployment.passwordHash`; `publish-republish-invariants.test.ts` drives the
 * loop end to end so the caller cannot pass the wrong thing again.
 */

const PAGE = 'export default function Page(){return null}';

describe('injectPreviewFiles — static HTML preview', () => {
  it('adds robots.txt and a noindex meta before </head>', () => {
    const files = injectPreviewFiles(
      { 'index.html': '<html><head><title>Site</title></head><body>Hi</body></html>' },
      { stack: 'STATIC_HTML', deployType: 'static' },
    );

    expect(files['robots.txt']).toBe('User-agent: *\nDisallow: /\n');
    expect(files['index.html']).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(files['index.html']).toMatch(/noindex, nofollow[\s\S]*<\/head>/i);
    expect(files['index.html']).toContain('<title>Site</title>');
  });

  it('leaves HTML that already has a robots meta alone', () => {
    const html =
      '<html><head><meta name="robots" content="index, follow" /></head><body></body></html>';
    const files = injectPreviewFiles(
      { 'about.htm': html },
      { stack: 'STATIC_HTML', deployType: 'static' },
    );

    expect(files['about.htm']).toBe(html);
    expect(files['robots.txt']).toBe('User-agent: *\nDisallow: /\n');
  });

  it('prepends noindex when the HTML has no </head>', () => {
    const files = injectPreviewFiles(
      { 'index.html': '<p>bare</p>' },
      { stack: 'STATIC_HTML', deployType: 'static' },
    );

    expect(files['index.html']).toBe(
      '<meta name="robots" content="noindex, nofollow" />\n<p>bare</p>',
    );
  });

  it('does not rewrite non-HTML files on a static preview', () => {
    const files = injectPreviewFiles(
      { 'styles.css': 'body{color:red}', 'index.html': '<html><head></head></html>' },
      { stack: 'STATIC_HTML', deployType: 'static' },
    );

    expect(files['styles.css']).toBe('body{color:red}');
    expect(files['index.html']).toContain('noindex, nofollow');
  });
});

describe('injectPreviewFiles — Next.js preview', () => {
  it('patches an existing next.config and does not invent a second one', () => {
    const files = injectPreviewFiles(
      { 'app/page.tsx': PAGE, 'next.config.mjs': 'export default { poweredByHeader: false };' },
      { stack: 'NEXTJS', deployType: 'node' },
    );

    expect(files['next.config.mjs']).toContain('X-Robots-Tag');
    expect(files['next.config.mjs']).toContain('poweredByHeader: false');
    expect(files).not.toHaveProperty('next.config.js');
    expect(files['middleware.ts']).toContain('X-Robots-Tag');
    expect(files['middleware.ts']).not.toContain('PREVIEW_PASSWORD');
  });

  it('leaves a next.config that already sets X-Robots-Tag', () => {
    const config =
      'module.exports = { headers: () => [{ key: "X-Robots-Tag", value: "noindex" }] };';
    const files = injectPreviewFiles(
      { 'app/page.tsx': PAGE, 'next.config.js': config },
      { stack: 'NEXTJS', deployType: 'node' },
    );

    expect(files['next.config.js']).toBe(config);
  });

  it('embeds the preview password check when the deployment is protected', () => {
    const files = injectPreviewFiles(
      { 'app/page.tsx': PAGE },
      { stack: 'NEXTJS', deployType: 'node', passwordProtected: true },
    );

    expect(files['middleware.ts']).toContain('PREVIEW_PASSWORD');
    expect(files['middleware.ts']).toContain('unauthorized()');
    // Fail closed: the app losing the env var must not reopen the preview.
    expect(files['middleware.ts']).toContain('if (!expected) return unauthorized();');
    expect(files['next.config.js']).toContain('X-Robots-Tag');
  });

  it('omits the 401 helper entirely when there is no gate to serve it', () => {
    const files = injectPreviewFiles(
      { 'app/page.tsx': PAGE },
      { stack: 'NEXTJS', deployType: 'node', passwordProtected: false },
    );

    // An unreferenced function would fail lint in the generated project.
    expect(files['middleware.ts']).not.toContain('unauthorized');
    expect(files['middleware.ts']).toContain('X-Robots-Tag');
  });
});
