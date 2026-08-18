import { assetStorageKey } from '@/lib/assets/keys';
import { optimizeImage } from '@/lib/assets/optimize';
import { upload } from '@/lib/storage';
import { adjustStorageBytes } from '@/lib/storage/usage';

const VIEWPORT = { width: 1280, height: 800 } as const;
const WAIT_MS = 10_000;

function toDataUrl(bytes: Buffer | Uint8Array) {
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}

async function storeThumbnail(buffer: Buffer, projectId?: string) {
  if (!projectId) return toDataUrl(buffer);
  try {
    const optimized = await optimizeImage(buffer);
    const key = assetStorageKey(projectId, optimized.ext);
    const stored = await upload(optimized.buffer, {
      key,
      contentType: optimized.contentType,
    });
    await adjustStorageBytes(optimized.sizeBytes);
    return stored.url;
  } catch (error) {
    console.warn('[checkpoints] thumbnail upload failed, storing data URL', error);
    return toDataUrl(buffer);
  }
}

async function captureWithPlaywright(previewUrl: string): Promise<Buffer> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.goto(previewUrl, { waitUntil: 'networkidle', timeout: WAIT_MS });
    return await page.screenshot({ type: 'png' });
  } finally {
    await browser.close();
  }
}

/** Best-effort stored URL (or legacy data URL). Never throws to the caller. */
export async function captureThumbnail(
  previewUrl?: string | null,
  projectId?: string,
): Promise<string | null> {
  // Only a real reachable URL can be shot. Previews now render in the user's
  // browser from a srcdoc, so there is nothing server-side to visit unless the
  // project has been published; callers pass that URL when they have it.
  const url = previewUrl?.trim();
  if (!url) return null;
  try {
    const buffer = await captureWithPlaywright(url);
    return storeThumbnail(buffer, projectId);
  } catch (error) {
    console.warn('[checkpoints] thumbnail capture failed', error);
    return null;
  }
}
