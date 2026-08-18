import { assertSafeUrl, UnsafeUrlError } from '../security/url-guard.ts';
import { BLOCKED_ACCESS_MESSAGE, isBlockedAccessError, toBlockedAccessError } from './errors.ts';
import { scrapeFirecrawlText } from './firecrawl.ts';
import { clusterColors, uniqueTrimmed } from './tokens.ts';
import type { CapturedImage, DesignTokens, PageCapture } from './types.ts';
import { normalizeSourceUrl } from './url.ts';

export { BLOCKED_ACCESS_MESSAGE, isBlockedAccessError } from './errors';

const DESKTOP = { width: 1440, height: 900 } as const;
const MOBILE = { width: 390, height: 844 } as const;
const WAIT_MS = 25_000;

const COOKIE_BUTTON_RE = /^(accept|agree|allow|got it|ok|i agree|accept all|allow all|continue)$/i;

type EvaluateResult = {
  fontFamily: string;
  fontSizes: string[];
  colors: string[];
  radii: string[];
  spacingRhythm: string[];
  images: CapturedImage[];
  loginWall: boolean;
};

async function dismissCookieBanners(page: {
  locator: (selector: string) => {
    all: () => Promise<Array<{ innerText: () => Promise<string>; click: (opts?: { timeout?: number }) => Promise<void> }>>;
  };
}) {
  try {
    const buttons = await page.locator('button, [role="button"], input[type="button"], input[type="submit"]').all();
    for (const button of buttons.slice(0, 40)) {
      const label = (await button.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (!label || !COOKIE_BUTTON_RE.test(label)) continue;
      await button.click({ timeout: 800 }).catch(() => undefined);
      break;
    }
  } catch {
    /* best-effort */
  }
}

function tokensFromEvaluate(raw: EvaluateResult): DesignTokens {
  return {
    fontFamily: raw.fontFamily || 'system-ui, sans-serif',
    fontSizes: uniqueTrimmed(raw.fontSizes, 8),
    colors: clusterColors(raw.colors, 8),
    radii: uniqueTrimmed(raw.radii, 8),
    spacingRhythm: uniqueTrimmed(raw.spacingRhythm, 8),
  };
}

export async function capturePage(
  sourceUrl: string,
  opts?: { userId?: string },
): Promise<PageCapture> {
  const url = (await assertSafeUrl(normalizeSourceUrl(sourceUrl), { userId: opts?.userId })).href;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: DESKTOP,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    await page.route('**/*', async (route) => {
      try {
        await assertSafeUrl(route.request().url(), { userId: opts?.userId });
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'networkidle', timeout: WAIT_MS });
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw error;
      const message = error instanceof Error ? error.message : '';
      if (/blockedbyclient|ERR_BLOCKED_BY_CLIENT/i.test(message)) {
        throw new UnsafeUrlError('private');
      }
      throw toBlockedAccessError(error);
    }
    const status = response?.status() ?? 0;
    if (status === 401 || status === 403 || status === 429) {
      throw new Error(BLOCKED_ACCESS_MESSAGE);
    }

    await dismissCookieBanners(page);
    await page.waitForTimeout(400).catch(() => undefined);

    const extracted = (await page.evaluate(() => {
      const skip = new Set(['', 'transparent', 'rgba(0, 0, 0, 0)', 'inherit', 'initial', 'none']);
      const fontSizes: string[] = [];
      const colors: string[] = [];
      const radii: string[] = [];
      const spacing: string[] = [];
      const images: { url: string; width: number; height: number; alt?: string }[] = [];
      const seenImg = new Set<string>();

      const nodes = Array.from(document.querySelectorAll('body, body *')).slice(0, 400);
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        const style = getComputedStyle(node);
        if (style.fontSize) fontSizes.push(style.fontSize);
        if (style.color && !skip.has(style.color)) colors.push(style.color);
        if (style.backgroundColor && !skip.has(style.backgroundColor)) colors.push(style.backgroundColor);
        if (style.borderRadius && style.borderRadius !== '0px') radii.push(style.borderRadius);
        if (style.paddingTop && style.paddingTop !== '0px') spacing.push(style.paddingTop);
        if (style.marginTop && style.marginTop !== '0px') spacing.push(style.marginTop);
        const bg = style.backgroundImage;
        const bgMatch = bg && bg !== 'none' ? bg.match(/url\(["']?(https?:[^"')]+)["']?\)/i) : null;
        if (bgMatch?.[1] && !seenImg.has(bgMatch[1])) {
          seenImg.add(bgMatch[1]);
          images.push({
            url: bgMatch[1],
            width: Math.round(node.getBoundingClientRect().width),
            height: Math.round(node.getBoundingClientRect().height),
          });
        }
      }

      for (const img of Array.from(document.images)) {
        const src = img.currentSrc || img.src;
        if (!src || src.startsWith('data:') || seenImg.has(src)) continue;
        seenImg.add(src);
        images.push({
          url: src,
          width: img.naturalWidth || Math.round(img.getBoundingClientRect().width),
          height: img.naturalHeight || Math.round(img.getBoundingClientRect().height),
          alt: img.alt || undefined,
        });
      }

      const password = document.querySelector('input[type="password"]');
      const loginText = /log\s*in|sign\s*in|verify you are human/i.test(document.body?.innerText?.slice(0, 800) || '');
      const body = getComputedStyle(document.body);

      return {
        fontFamily: body.fontFamily || 'system-ui, sans-serif',
        fontSizes,
        colors,
        radii,
        spacingRhythm: spacing,
        images,
        loginWall: Boolean(password && loginText && document.body.innerText.trim().length < 800),
      };
    })) as EvaluateResult;

    if (extracted.loginWall) {
      throw new Error(BLOCKED_ACCESS_MESSAGE);
    }

    const desktopPng = Buffer.from(await page.screenshot({ type: 'png', fullPage: true }));
    await page.setViewportSize(MOBILE);
    await page.waitForTimeout(200).catch(() => undefined);
    const mobilePng = Buffer.from(await page.screenshot({ type: 'png', fullPage: true }));

    // Trusted host — scrapeFirecrawlText does not route through safeFetch.
    const firecrawl = await scrapeFirecrawlText(url);
    return {
      sourceUrl: url,
      desktopPng,
      mobilePng,
      tokens: tokensFromEvaluate(extracted),
      images: extracted.images.filter((image) => /^https?:\/\//i.test(image.url)),
      firecrawlText: firecrawl.ok ? firecrawl.markdown : '',
      firecrawl,
      capturedAt: new Date(),
    };
  } catch (error) {
    throw toBlockedAccessError(error);
  } finally {
    // Closing is cleanup: a close failure must not replace the capture error.
    await browser.close().catch((error) => {
      console.warn('[import] browser close failed', error);
    });
  }
}
