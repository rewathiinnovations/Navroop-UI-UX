import { describe, expect, it } from 'vitest';
import { absoluteSandboxPath } from '@/lib/sandbox/providers/sandbox-path';
import { base64DecodeWriteCommand } from '@/lib/sandbox/providers/shell-file-write';

/**
 * `printf %s ${JSON.stringify(content)}` is the Modal/Daytona-fallback bug:
 * JSON.stringify turns a newline into the two characters `\` and `n`, and
 * `printf %s` does not interpret them. npm then printed
 * `{\n  "name": "sandbox...` from `//package.json`.
 */
const PACKAGE_JSON = '{\n  "name": "sandbox-app",\n  "private": true\n}\n';
const PRINTF_CORRUPT_PACKAGE_JSON = '{\\n  "name": "sandbox-app",\\n  "private": true\\n}\\n';

function printfJsonStringifyWouldWrite(content: string): string {
  const escaped = JSON.stringify(content);
  const inner = escaped.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === '"' || next === '\\') {
        out += next;
        i += 1;
        continue;
      }
    }
    out += inner[i];
  }
  return out;
}

describe('the printf + JSON.stringify write (the captured Modal payload)', () => {
  it('is exactly the corrupt near-text npm printed', () => {
    expect(printfJsonStringifyWouldWrite(PACKAGE_JSON)).toBe(PRINTF_CORRUPT_PACKAGE_JSON);
    expect(printfJsonStringifyWouldWrite(PACKAGE_JSON)).not.toBe(PACKAGE_JSON);
    expect(printfJsonStringifyWouldWrite(PACKAGE_JSON).startsWith('{\\n  "name": "sandbox')).toBe(
      true,
    );
  });
});

describe('absoluteSandboxPath', () => {
  it('makes relative paths absolute without a double slash', () => {
    expect(absoluteSandboxPath('package.json')).toBe('/package.json');
    expect(absoluteSandboxPath('src/App.tsx')).toBe('/src/App.tsx');
    expect(absoluteSandboxPath('/package.json')).toBe('/package.json');
    expect(absoluteSandboxPath('//package.json')).toBe('/package.json');
  });

  it('does not move an app that already lives at container root', () => {
    expect(absoluteSandboxPath('app/page.tsx')).toBe('/app/page.tsx');
    expect(absoluteSandboxPath('/app/page.tsx')).toBe('/app/page.tsx');
  });
});

describe('base64DecodeWriteCommand (Daytona shell fallback)', () => {
  it('does not put the raw JSON.stringify payload on the printf side', () => {
    const command = base64DecodeWriteCommand('package.json', PACKAGE_JSON);
    expect(command).not.toContain(PRINTF_CORRUPT_PACKAGE_JSON);
    expect(command).toContain('base64 -d');
    const encoded = Buffer.from(PACKAGE_JSON, 'utf8').toString('base64');
    expect(command).toContain(JSON.stringify(encoded));
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(PACKAGE_JSON);
  });

  it('round-trips quotes, $, backticks, unicode, and trailing-newline presence', () => {
    const special = 'const x = "`$\'\\\\";\ncafé\n';
    const encoded = Buffer.from(special, 'utf8').toString('base64');
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(special);
    expect(base64DecodeWriteCommand('/tmp/x.ts', special)).toContain(JSON.stringify(encoded));
  });
});
