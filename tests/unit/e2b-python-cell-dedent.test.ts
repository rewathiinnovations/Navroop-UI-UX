import { describe, expect, it } from 'vitest';
import { E2BProvider } from '@/lib/sandbox/providers/e2b-provider';

/**
 * E2B cells are Python. The provider's template literals carry TypeScript
 * indentation, and the kernel does not dedent — every cell died on
 * IndentationError before its first line, so every runCommand returned
 * exit 1 with empty streams and the provider could never test healthy.
 */
describe('E2BProvider.dedentPythonCell', () => {
  it('strips the common leading indent so top-level Python parses', () => {
    const cell = `
      import subprocess
      import os

      os.chdir('/home/user/app')
      result = subprocess.run(['echo', 'hi'],
                            capture_output=True)
      print(result.returncode)
    `;
    const dedented = E2BProvider.dedentPythonCell(cell);
    const lines = dedented.split('\n').filter((line) => line.trim());
    expect(lines[0]).toBe('import subprocess');
    // Relative indentation inside the cell survives (continuation lines).
    expect(dedented).toContain('\n                      capture_output=True)');
    expect(lines.every((line) => !/^\s/.test(line) || /^ {2,}/.test(line))).toBe(true);
  });

  it('leaves already-flush code unchanged', () => {
    const cell = "import os\nprint(os.getcwd())";
    expect(E2BProvider.dedentPythonCell(cell)).toBe(cell);
  });

  it('handles blank lines without counting them toward the common indent', () => {
    const cell = '\n    a = 1\n\n    b = 2\n';
    expect(E2BProvider.dedentPythonCell(cell)).toBe('a = 1\n\nb = 2\n');
  });
});
