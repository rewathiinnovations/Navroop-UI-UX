/** No i18n catalog exists. User-facing copy must stay English. */

const DEVANAGARI = /[\u0900-\u097F]/;
const BANNED = /\bklarco\b/i;

export function findNonEnglishUserCopy(text: string) {
  const hits: string[] = [];
  if (DEVANAGARI.test(text)) hits.push('hindi');
  if (BANNED.test(text)) hits.push('klarco');
  return hits;
}

export function assertEnglishUserCopy(text: string, label = 'copy') {
  const hits = findNonEnglishUserCopy(text);
  if (hits.length > 0) {
    throw new Error(`${label} contains banned or non-English copy: ${hits.join(', ')}`);
  }
}
