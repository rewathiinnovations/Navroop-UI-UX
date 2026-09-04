/**
 * Public token-gated preview shell. New-tab opens `/preview-view?projectId=&token=`.
 * The page loads project files and renders them in BrowserPreview (srcdoc).
 * Generated JS never runs top-level on the app origin (F-140).
 */

export const PUBLIC_PREVIEW_VIEW_PATH = '/preview-view';

/** Serializable site the public shell hands to BrowserPreview. */
export type PublicPreviewSite = {
  ok: true;
  stack: string;
  designDirection: string | null;
  files: Record<string, string>;
};

export function publicPreviewViewHref(input: { projectId: string; token: string }): string {
  const params = new URLSearchParams({
    projectId: input.projectId,
    token: input.token,
  });
  return `${PUBLIC_PREVIEW_VIEW_PATH}?${params}`;
}

export function parsePublicPreviewViewSearch(
  search: Record<string, string | string[] | undefined> | { projectId?: string; token?: string; u?: string },
): { projectId: string; token: string } | null {
  const projectId = firstSearchValue(search, 'projectId');
  const token = firstSearchValue(search, 'token');
  if (!projectId || !token) return null;
  return { projectId, token };
}

function firstSearchValue(
  search: Record<string, string | string[] | undefined> | { projectId?: string; token?: string; u?: string },
  key: 'projectId' | 'token',
): string | null {
  const raw = search[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed || null;
}

/** Open-in-new-tab is a site, not a Cloudflare origin. */
export function canOpenPreviewInNewTab(input: {
  hasStoredFiles: boolean;
  previewUrl?: string | null;
}): boolean {
  return Boolean(input.hasStoredFiles);
}

/** Prefer a minted href; otherwise ask the caller to mint (POST action:token). */
export async function resolveNewTabPreviewHref(input: {
  previewUrl: string | null | undefined;
  mint?: () => Promise<string | null>;
}): Promise<string | null> {
  if (input.previewUrl) return input.previewUrl;
  if (!input.mint) return null;
  return (await input.mint()) ?? null;
}
