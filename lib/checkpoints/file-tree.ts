export type FileTreeNode = {
  path: string;
  name: string;
  type: 'file' | 'dir';
  children?: FileTreeNode[];
};

/**
 * Build a path-only tree from a file map. Contents are never copied.
 * Used for large checkpoint previews (budget: 300 checkpoints / 200 files).
 */
export function fileTreeFromPaths(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const raw of paths) {
    const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
    let level = root;
    let prefix = '';
    for (let i = 0; i < parts.length; i += 1) {
      const name = parts[i];
      prefix = prefix ? `${prefix}/${name}` : name;
      const isFile = i === parts.length - 1;
      let node = level.find((row) => row.name === name && row.type === (isFile ? 'file' : 'dir'));
      if (!node) {
        node = { path: prefix, name, type: isFile ? 'file' : 'dir', children: isFile ? undefined : [] };
        level.push(node);
      }
      if (!isFile) {
        node.children = node.children ?? [];
        level = node.children;
      }
    }
  }

  return root;
}

export function flattenFileTree(nodes: FileTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (rows: FileTreeNode[]) => {
    for (const row of rows) {
      if (row.type === 'file') out.push(row.path);
      if (row.children) walk(row.children);
    }
  };
  walk(nodes);
  return out;
}
