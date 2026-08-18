import type { LiveDocument, LiveText } from './types';

const TIMEOUT_MS = 8000;

async function fetchText(url: string): Promise<{ status: number; text: string; url: string; headers: Record<string, string> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Trusted host — do not route through safeFetch.
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const text = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, text, url: response.url, headers };
  } catch (error) {
    // status 0 is the "unreachable" sentinel the audit checks read, but the reason
    // is only useful if it is logged.
    console.warn('[seo] preview fetch failed', url, error);
    return { status: 0, text: '', url, headers: {} };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPreviewDocument(previewUrl: string): Promise<LiveDocument> {
  const result = await fetchText(previewUrl);
  return {
    url: result.url,
    status: result.status,
    html: result.text,
    headers: result.headers,
  };
}

export async function fetchPreviewText(previewUrl: string, path: string): Promise<LiveText> {
  const base = previewUrl.replace(/\/$/, '');
  const result = await fetchText(`${base}${path}`);
  return { status: result.status, text: result.text };
}
