import { z } from 'zod';

/**
 * Zod's `.url()` validates by constructing `new URL(value)`, which accepts
 * every scheme — `javascript:`, `file:`, `data:`, `vbscript:`, `blob:`. Values
 * that passed it were persisted and served back to clients, so they were inert
 * only for as long as nobody rendered one as an `<a href>` (F-742).
 *
 * Three call sites need this in lockstep — the avatar URL, the template preview
 * URL and the generation `previewUrl` — hence one exported schema factory
 * rather than three refinements that can drift.
 */
export const HTTP_URL_MESSAGE = 'Enter an http(s) URL';

export function httpUrl(maxLength: number) {
  return z
    .string()
    .trim()
    .max(maxLength, `URL must be at most ${maxLength} characters`)
    .refine((value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === 'http:' || protocol === 'https:';
      } catch {
        return false;
      }
    }, HTTP_URL_MESSAGE);
}
