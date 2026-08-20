import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { createGithubCsrf } from '@/lib/integrations/csrf';
import { githubManifest, githubNewAppUrl } from '@/lib/integrations/github-manifest';
import { appPublicUrl } from '@/lib/settings/app-url';
import { workspaceDisplayName } from '@/lib/settings/workspace-name';

function escapeAttr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export async function GET(request: NextRequest) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });

  const org = request.nextUrl.searchParams.get('org')?.trim() || '';
  const csrf = await createGithubCsrf(org, user.id);
  const workspaceName = await workspaceDisplayName();
  const manifest = githubManifest({
    workspaceName,
    appUrl: await appPublicUrl(),
    org: csrf.org,
  });
  const action = githubNewAppUrl(csrf.org || null, csrf.state);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Connect GitHub</title></head>
<body>
<form method="post" action="${escapeAttr(action)}">
<input type="hidden" name="manifest" value="${escapeAttr(JSON.stringify(manifest))}">
</form>
<script>document.forms[0].submit()</script>
<p>Opening GitHub…</p>
</body></html>`;
  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
