import { spawn } from 'node:child_process';
import { isSchemaDriftCommand, runSchemaDriftCheck } from '../lib/verify/schema-drift.ts';
import { runVerify, type VerifyRunResult } from '../lib/verify/orchestrator.ts';

function runCommand(command: string) {
  if (isSchemaDriftCommand(command)) {
    return Promise.resolve(runSchemaDriftCheck());
  }
  return new Promise<{ ok: boolean; output?: string }>((resolve) => {
    const child = spawn(command, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      env: process.env,
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      process.stdout.write(text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      process.stderr.write(text);
    });
    child.on('error', (error) => {
      resolve({ ok: false, output: error.message });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, output });
    });
  });
}

function printSummary(result: VerifyRunResult) {
  console.log('');
  console.log(result.mode);
  for (const line of result.summaryLines) {
    console.log(line);
  }
}

// `--light` is what .husky/pre-push passes: the fast fatal steps run here, the
// slow half is deferred to CI, which runs the complete `verify` on the same push
// (`.github/workflows/verify.yml`). `pnpm run verify` stays the full local gate,
// and `--full` outranks `--light` if both are ever passed.
const mode =
  process.argv.includes('--full') || process.env.VERIFY_FULL === '1'
    ? 'verify:full'
    : process.argv.includes('--light') || process.env.VERIFY_LIGHT === '1'
      ? 'verify:light'
      : 'verify';
const result = await runVerify({ mode, runCommand });
printSummary(result);
process.exit(result.ok ? 0 : 1);
