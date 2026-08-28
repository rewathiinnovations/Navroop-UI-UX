import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROUTE = fileURLToPath(
  new URL('../../app/api/generate-ai-code-stream/route.ts', import.meta.url),
);

describe('a failed Brain memory block on generate is reported', () => {
  it('logs generation.memory_block_failed with the project id and does not throw', () => {
    const source = readFileSync(ROUTE, 'utf8');
    const memoryAt = source.indexOf(
      'memoryBlock = (await buildMemoryBlock(memoryProjectId)).block',
    );
    expect(memoryAt).toBeGreaterThan(0);
    const catchBlock = source.slice(memoryAt, memoryAt + 400);
    expect(catchBlock).toMatch(/logError\(\s*'generation\.memory_block_failed'/);
    expect(catchBlock).toMatch(/projectId/);
    expect(catchBlock).not.toMatch(/console\.warn\(\s*'\[memory\]/);
    expect(catchBlock).toMatch(/catch \(error\) \{/);
  });
});
