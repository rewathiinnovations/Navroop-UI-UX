export type AssetManifestRow = {
  url: string;
  altText: string;
  width: number;
  height: number;
  kind: string;
};

export function formatAssetManifest(rows: AssetManifestRow[]) {
  if (rows.length === 0) {
    return [
      'PROJECT ASSETS: none yet.',
      'Request every image with a single line: NEED_IMAGE: description | 16:9 (or 1:1, 4:5, 1200x630).',
      'The pipeline replaces NEED_IMAGE tokens with real asset URLs before files are written.',
    ].join('\n');
  }
  const lines = [
    'PROJECT ASSETS (reuse these URLs and altText; request a new image only when nothing fits):',
    ...rows.map(
      (row) =>
        `- ${row.url} | ${row.altText} | ${row.width}x${row.height} | ${row.kind}`,
    ),
    'To request a NEW image: NEED_IMAGE: description | 16:9 (or 1:1, 4:5, 1200x630).',
  ];
  return lines.join('\n');
}
