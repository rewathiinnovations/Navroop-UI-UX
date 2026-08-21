import { getSettings } from '@/lib/settings/resolve';
import type { GenerateAspect } from '@/lib/assets/generate-image';

/**
 * The self-hosted image endpoint: one POST with a prompt, one image back.
 *
 * Verified against the live Worker (2026-08-20): HTTP 200, ~12 s, 1.3 MB, and a
 * body whose `Content-Type` says `image/jpeg` while the bytes are PNG. Nothing
 * here trusts that header — `persistOptimizedAsset` re-encodes through sharp,
 * which reads the real format — but it is why no extension is derived from it.
 */
export type WorkerImageConfig = { url: string; token: string; model?: string };

/** Roughly how the Worker should frame the shot, since it takes only a prompt. */
const FRAMING: Record<GenerateAspect, string> = {
  '16:9': 'wide 16:9 landscape composition',
  '1:1': 'square 1:1 composition',
  '4:5': 'vertical 4:5 portrait composition',
  '1200x630': 'wide 1200x630 banner composition, subject slightly off-centre',
};

/**
 * How to actually get an image with no lettering in it.
 *
 * Measured against the live Worker, not assumed:
 * - "no text, no words, no letters … no typography of any kind" produced a
 *   storefront with a sign reading "PITZZRIA PIZZEA IZZA". Negation is ignored.
 * - Passing `negative_prompt: 'text, letters, words, signage …'` produced signs
 *   reading "WOOD" and "PIZZERA". The endpoint ignores the field.
 * - Describing plain surfaces positively, and framing an interior instead of a
 *   shopfront, produced a clean image with no lettering anywhere.
 *
 * So the strategy is subject-level: state the absence as a property of the scene
 * ("blank unmarked walls"), and steer away from the subjects that carry writing in
 * real life. A model that cannot spell will not be talked out of writing.
 */
const PLAIN_SURFACES =
  'Blank unmarked walls, plain undecorated surfaces, no printed matter anywhere in frame.';

/**
 * Subjects whose real-world form is covered in writing, and what to shoot instead.
 *
 * An instruction not to include lettering is ignored; the *subject* has to change.
 * Measured on the same description across two models: asking for a "storefront"
 * with a reframing hint appended still produced "WOOD & PIZZERIA" signage under
 * `lucid-origin`, because the noun is what the model draws. Replacing the noun is
 * the only thing that holds — a pizzeria's shopfront needs a sign to read as a
 * pizzeria, its oven does not.
 */
const SUBJECT_SUBSTITUTIONS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b(storefronts?|shopfronts?|shop fronts?)\b/gi, replacement: 'interior' },
  { pattern: /\b(fa[c\u00e7]ades?|street views?|exteriors?)\b/gi, replacement: 'interior' },
  {
    pattern: /\b(menu boards?|chalkboards?|blackboards?|menus?)\b/gi,
    replacement: 'serving counter',
  },
  {
    pattern:
      /\b(signage|signboards?|signs?|billboards?|hoardings?|posters?|banners?|flyers?|leaflets?|brochures?)\b/gi,
    replacement: 'plain wall',
  },
  { pattern: /\b(packaging|packages?|labels?)\b/gi, replacement: 'unmarked container' },
  {
    pattern:
      /\b(laptops?|phones?|monitors?|screens?|dashboards?|websites?|apps?|interfaces?|uis?)\b/gi,
    replacement: 'hands at work',
  },
  {
    pattern: /\b(books?|magazines?|newspapers?|business cards?|receipts?|tickets?)\b/gi,
    replacement: 'folded cloth',
  },
];

/** True when the description named something that is normally covered in writing. */
function rewriteSubject(description: string): { subject: string; substituted: boolean } {
  let subject = description;
  let substituted = false;
  for (const rule of SUBJECT_SUBSTITUTIONS) {
    // Compare instead of `.test()`: these patterns are global and module-level, so
    // a `test` would leave `lastIndex` behind and make a later call miss.
    const next = subject.replace(rule.pattern, rule.replacement);
    if (next === subject) continue;
    substituted = true;
    subject = next;
  }
  return { subject, substituted };
}
const INTERIOR_FRAMING =
  'Shot from inside as a close detail, not from the street, so nothing written is in view.';

export function imageWorkerPrompt(description: string, aspect: GenerateAspect): string {
  const { subject, substituted } = rewriteSubject(description.trim().replace(/\s+/g, ' '));
  return [
    subject,
    `Photographic, natural light, realistic detail, ${FRAMING[aspect]}.`,
    PLAIN_SURFACES,
    substituted ? INTERIOR_FRAMING : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ');
}
/** The configured endpoint, or null when the operator has not set one up. */
export async function imageWorkerConfig(): Promise<WorkerImageConfig | null> {
  const values = await getSettings([
    'tooling.images.workerUrl',
    'tooling.images.token',
    'tooling.images.model',
  ] as const);

  const url = values['tooling.images.workerUrl']?.trim();
  const token = values['tooling.images.token']?.trim();
  if (!url || !token) return null;
  return { url, token, model: values['tooling.images.model']?.trim() || undefined };
}

/** Hard ceiling for image worker response — 10 MB is generous for any single image. */
const MAX_IMAGE_WORKER_RESPONSE_BYTES = 10 * 1024 * 1024;

export async function generateWithImageWorker(input: {
  config: WorkerImageConfig;
  description: string;
  aspect: GenerateAspect;
  /** Milliseconds before the request is abandoned; the worker takes ~12 s. */
  timeoutMs?: number;
}): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 60_000);
  try {
    const response = await fetch(input.config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.config.token}`,
        'Content-Type': 'application/json',
      },
      // `model` is omitted entirely when unset, so the worker applies its own
      // default rather than being handed an empty string to resolve.
      body: JSON.stringify({
        prompt: imageWorkerPrompt(input.description, input.aspect),
        ...(input.config.model ? { model: input.config.model } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Image worker refused the request (${response.status})${await reason(response)}`,
      );
    }
    // Enforce a hard byte ceiling to prevent memory exhaustion from a runaway response.
    const headers = response.headers as Record<string, string> | undefined;
    const contentLength = headers?.['content-length'];
    if (contentLength && Number(contentLength) > MAX_IMAGE_WORKER_RESPONSE_BYTES) {
      throw new Error(
        `Image worker response too large: ${contentLength} bytes (max ${MAX_IMAGE_WORKER_RESPONSE_BYTES})`,
      );
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_IMAGE_WORKER_RESPONSE_BYTES) {
      throw new Error(
        `Image worker response too large: ${body.length} bytes (max ${MAX_IMAGE_WORKER_RESPONSE_BYTES})`,
      );
    }
    const image = imageBytesFrom(body);
    // The worker labels every answer `image/jpeg`, including its own JSON errors,
    // so the bytes are what decide. Storing a non-image would render as a broken
    // picture on the finished site.
    if (!image) {
      throw new Error('Image worker answered with something that is not an image');
    }
    return image;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Image worker did not answer in time');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The worker's own words for a failure: it answers JSON `{ error, details }` for
 * an unauthorized token, a wrong method, a missing prompt, or a model that blew
 * up. A bare status code sends an operator hunting; "Unauthorized" does not.
 */
async function reason(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') return '';
    const error = 'error' in body && typeof body.error === 'string' ? body.error : null;
    const details = 'details' in body && typeof body.details === 'string' ? body.details : null;
    if (!error && !details) return '';
    return `: ${[error, details].filter(Boolean).join(' — ')}`;
  } catch {
    return '';
  }
}

/** PNG, JPEG, WebP or GIF magic bytes — the header is not trustworthy here. */
function looksLikeImage(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return true;
  if (buffer.subarray(1, 4).toString('latin1') === 'PNG') return true;
  if (buffer.subarray(0, 4).toString('latin1') === 'GIF8') return true;
  return (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  );
}

/**
 * The image bytes in whatever form the worker sent them, or null.
 *
 * Cloudflare's image models do not agree on an output shape: the FLUX klein
 * models return raw bytes, while `flux-1-schnell` and the SDXL family answer
 * `{ image: "<base64>" }`. The worker forwards `result.image` straight into a
 * `Response`, so that arrives here as base64 *text* labelled `image/jpeg` —
 * verified live: selecting `flux-1-schnell` produced exactly that. Decoding it
 * here means an operator can pick those models without editing the worker.
 */
function imageBytesFrom(body: Buffer): Buffer | null {
  if (looksLikeImage(body)) return body;

  // Base64 of an image is ASCII and starts with the encoded magic bytes: JPEG is
  // `/9j/`, PNG `iVBOR`. Checking the prefix avoids decoding a JSON error page.
  const head = body.subarray(0, 16).toString('latin1');
  if (!/^[A-Za-z0-9+/]{8}/.test(head)) return null;
  if (!head.startsWith('/9j/') && !head.startsWith('iVBOR')) return null;

  const decoded = Buffer.from(body.toString('latin1'), 'base64');
  return looksLikeImage(decoded) ? decoded : null;
}
