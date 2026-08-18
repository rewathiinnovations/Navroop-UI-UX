/**
 * Log a --no-verify / verify bypass so it is visible in git.
 * Usage: pnpm run verify:bypass -- "reason"
 * Then: git push --no-verify
 */
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const reason = process.argv.slice(2).join(' ').trim() || 'no reason given';
const who = process.env.GIT_AUTHOR_NAME || process.env.USERNAME || process.env.USER || 'unknown';
const line = `${new Date().toISOString()}\t${who}\t${reason.replace(/\s+/g, ' ')}\n`;
const file = resolve(process.cwd(), 'docs/verify-bypasses.log');
appendFileSync(file, line, 'utf8');
console.log(`Logged bypass to docs/verify-bypasses.log`);
console.log('Commit that file with your push. Then: git push --no-verify');
