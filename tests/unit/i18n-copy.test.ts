import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findNonEnglishUserCopy } from '../../lib/i18n/user-copy';

function walk(dir: string, acc: string[] = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, acc);
    else if (/\.(tsx|ts)$/.test(name)) acc.push(full);
  }
  return acc;
}

describe('i18n sanity (no catalog)', () => {
  it('user-facing app and component strings contain no Hindi and no klarco', () => {
    const files = [...walk(join(process.cwd(), 'app')), ...walk(join(process.cwd(), 'components'))];
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const found = findNonEnglishUserCopy(text);
      if (found.length) hits.push(`${file}: ${found.join(',')}`);
    }
    expect(hits).toEqual([]);
  });
});
