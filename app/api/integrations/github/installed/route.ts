import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { discoverGithubInstallation } from '@/lib/integrations/github';
import { appUrl } from '@/lib/integrations/github-manifest';

export async function GET(request: NextRequest) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });

  const installationId = request.nextUrl.searchParams.get('installation_id');
  const result = await discoverGithubInstallation({ installationId });
  if (result.found) {
    return NextResponse.redirect(new URL('/admin/integrations?github=connected', appUrl()));
  }

  const retry = `${appUrl()}/api/integrations/github/installed`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>GitHub install</title>
<style>
  body { font-family: ui-sans-serif, system-ui; max-width: 420px; margin: 64px auto; color: #18181b; }
  a { display: inline-block; margin-top: 16px; padding: 10px 16px; border-radius: 999px; background: #18181b; color: #fff; text-decoration: none; }
</style></head>
<body>
  <p>Installation is not complete yet</p>
  <a href="${retry}">Try again</a>
  <p><a href="${appUrl()}/admin/integrations" style="background:transparent;color:#18181b;text-decoration:underline">Back to integrations</a></p>
</body></html>`;
  return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
