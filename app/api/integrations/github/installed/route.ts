import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { discoverGithubInstallation } from '@/lib/integrations/github';
import { appPublicUrl } from '@/lib/settings/app-url';

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
  body { font-family: ui-sans-serif, system-ui; max-width: 460px; margin: 64px auto; color: #18181b; }
  a.button { display: inline-block; margin-top: 12px; padding: 10px 16px; border-radius: 999px; background: #18181b; color: #fff; text-decoration: none; }
  a.plain { background: transparent; color: #18181b; text-decoration: underline; }
  ul { list-style: none; padding: 0; }
  li { margin-top: 8px; }
`;

function page(title: string, body: string) {
  return new NextResponse(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${STYLE}</style></head>
<body>${body}</body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

export async function GET(request: NextRequest) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });

  const origin = await appPublicUrl();
  const installationId = request.nextUrl.searchParams.get('installation_id');
  const result = await discoverGithubInstallation({ installationId });
  if (result.found) {
    return NextResponse.redirect(new URL('/admin/integrations?github=connected', origin));
  }

  const retry = `${origin}/api/integrations/github/installed`;
  const back = `<p><a class="button plain" href="${origin}/admin/integrations">Back to integrations</a></p>`;

  // The App is installed on accounts we were not asked about, so the operator picks. This
  // used to adopt `list[0]` and rewrite the configured org to match, which pointed the
  // create/force-push/delete path at an unintended GitHub account (F-235).
  if (result.reason === 'ambiguous') {
    const options = result.installations
      .map(
        (row) =>
          `<li><a class="button" href="${retry}?installation_id=${encodeURIComponent(row.id)}">${escapeHtml(
            row.accountLogin || `installation ${row.id}`,
          )}</a></li>`,
      )
      .join('');
    return page(
      'Choose a GitHub account',
      `<p>This app is installed on more than one account, and none of them matches the organisation configured here. Published sites are created, force-pushed to and deleted in the account you choose.</p>
  <ul>${options}</ul>
  ${back}`,
    );
  }

  return page(
    'GitHub install',
    `<p>Installation is not complete yet</p>
  <p><a class="button" href="${retry}">Try again</a></p>
  ${back}`,
  );
}
