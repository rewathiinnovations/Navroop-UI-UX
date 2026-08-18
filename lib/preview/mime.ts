const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  map: 'application/json; charset=utf-8',
  wasm: 'application/wasm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  eot: 'application/vnd.ms-fontobject',
};

const TEXT_TYPES = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg', 'txt', 'xml', 'map']);

export function contentTypeForPath(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return TYPES[ext] || 'application/octet-stream';
}

export function shouldGzipPreviewPath(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return TEXT_TYPES.has(ext);
}
