import { describe, expect, it } from 'vitest';
import { fileTreeFromPaths, flattenFileTree } from '../../lib/checkpoints/file-tree';

describe('file tree without contents', () => {
  it('meets the 200-file budget without storing contents', () => {
    const paths = Array.from({ length: 200 }, (_, i) => `src/f${i}/File.tsx`);
    const started = Date.now();
    const tree = fileTreeFromPaths(paths);
    expect(Date.now() - started).toBeLessThan(200);
    expect(flattenFileTree(tree)).toHaveLength(200);
    expect(JSON.stringify(tree)).not.toContain('export default');
  });
});
