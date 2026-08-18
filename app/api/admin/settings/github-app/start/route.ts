import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { createGithubCsrf } from '@/lib/integrations/csrf';
import {
  appUrl,
  githubConnectorsManifest,
  githubNewAppUrl,
} from '@/lib/integrations/github-manifest';

/**
 * One-click setup for the connectors GitHub app.
 *
 * Auto-submits a GitHub App Manifest so the admin never hand-registers an
 * OAuth app: GitHub creates it and redirects back to our callback, which
 * saves the returned client id/secret straight into Admin → Configuration.
 * Same pattern as the deploy app on /admin/integrations.
 */

function escapeAttr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export async function GET() {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });

  const csrf = await createGithubCsrf('', user.id);
  const workspaceName = process.env.NEXT_PUBLIC_WORKSPACE_NAME?.trim() || 'Navroop';
  const manifest = githubConnectorsManifest({ workspaceName, appUrl: appUrl() });
  const action = githubNewAppUrl(null, csrf.state);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Create GitHub app</title></head>
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
