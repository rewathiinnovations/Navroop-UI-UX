import type { StackId } from '@/lib/stacks';
import { getStack } from '@/lib/stacks';
import { finding } from './findings';
import { toolFailedFinding } from './static/tool-fail';
import type { BundleAsset, BundleMeasure, CodeFinding, SandboxRunner } from './types';

const SANDBOX_LABEL = 'sandbox-environment estimate';
const TOTAL_JS_LIMIT_KB = 300;
const CHUNK_LIMIT_KB = 150;

export function measureShouldSkip(stack: StackId): boolean {
  return stack === 'STATIC_HTML' || !getStack(stack).buildCommand;
}

export function findingsFromBundle(measure: BundleMeasure): CodeFinding[] {
  if (!measure.ok) {
    return [
      finding({
        id: 'bundle:build-failed',
        category: 'bundle',
        status: 'high',
        title: `Production build failed (${SANDBOX_LABEL})`,
        detail: `${measure.error || 'Build failed'}. This is a ${SANDBOX_LABEL} — the sandbox production build, not a production host.`,
      }),
    ];
  }

  const js = measure.assets.filter((asset) => asset.kind === 'js');
  const totalJs = js.reduce((sum, asset) => sum + asset.gzipKb, 0);
  const findings: CodeFinding[] = [];

  if (totalJs > TOTAL_JS_LIMIT_KB) {
    findings.push(
      finding({
        id: 'bundle:total-js',
        category: 'bundle',
        status: 'medium',
        title: `Total JS is ${Math.round(totalJs)}KB gzipped (${SANDBOX_LABEL})`,
        detail: `Combined JS is ${Math.round(totalJs)}KB gzipped, above the 300KB sandbox budget. This is a ${SANDBOX_LABEL}.`,
      }),
    );
  }

  for (const chunk of js.filter((asset) => asset.gzipKb > CHUNK_LIMIT_KB)) {
    findings.push(
      finding({
        id: `bundle:chunk:${chunk.path}`,
        category: 'bundle',
        status: 'medium',
        title: `Large JS chunk ${chunk.path} (${SANDBOX_LABEL})`,
        detail: `${chunk.path} is ${Math.round(chunk.gzipKb)}KB gzipped, above the 150KB chunk budget. This is a ${SANDBOX_LABEL}.`,
        filePath: chunk.path,
      }),
    );
  }

  for (const image of measure.assets.filter(
    (asset) => asset.kind === 'image' && isUnoptimizedImage(asset.path),
  )) {
    findings.push(
      finding({
        id: `bundle:image:${image.path}`,
        category: 'bundle',
        status: 'medium',
        title: `Unoptimized image ${image.path} (${SANDBOX_LABEL})`,
        detail: `${image.path} is a raster image in the production output (${Math.round(image.rawKb)}KB). Prefer WebP/AVIF or an optimized asset. This is a ${SANDBOX_LABEL}.`,
        filePath: image.path,
      }),
    );
  }

  if (measure.routeCount > 1 && js.length < measure.routeCount) {
    findings.push(
      finding({
        id: 'bundle:code-split',
        category: 'bundle',
        status: 'low',
        title: `Missing code-split for multiple routes (${SANDBOX_LABEL})`,
        detail: `${measure.routeCount} routes share a single JS bundle. Split per-route so unused pages are not downloaded. This is a ${SANDBOX_LABEL}.`,
      }),
    );
  }

  return findings;
}

function isUnoptimizedImage(filePath: string): boolean {
  return /\.(png|jpe?g|gif|bmp|tiff?)$/i.test(filePath);
}

export function totalBundleKb(assets: BundleAsset[]): number | null {
  const js = assets.filter((asset) => asset.kind === 'js');
  if (js.length === 0) return null;
  return Math.round(js.reduce((sum, asset) => sum + asset.gzipKb, 0) * 10) / 10;
}

const MEASURE_SCRIPT = `const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const roots = ['.next', 'dist', 'build', 'out'].filter((dir) => fs.existsSync(dir));
const assets = [];
function kind(file) {
  if (/\\.(js|mjs|cjs)$/i.test(file)) return 'js';
  if (/\\.css$/i.test(file)) return 'css';
  if (/\\.(png|jpe?g|gif|webp|avif|svg|bmp|tiff?)$/i.test(file)) return 'image';
  return 'other';
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) {
      const buf = fs.readFileSync(full);
      assets.push({
        path: full.replace(/\\\\/g, '/'),
        kind: kind(full),
        rawKb: buf.length / 1024,
        gzipKb: zlib.gzipSync(buf).length / 1024,
      });
    }
  }
}
for (const root of roots) walk(root);
process.stdout.write(JSON.stringify({ assets }));
`;

function parseAssets(raw: string): BundleAsset[] {
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw) as {
      assets?: BundleAsset[];
    };
    return Array.isArray(parsed.assets) ? parsed.assets : [];
  } catch {
    return [];
  }
}

export async function runBundleMeasure(
  stack: StackId,
  sandbox: SandboxRunner | null,
  routeCount: number,
): Promise<{ findings: CodeFinding[]; bundleKb: number | null }> {
  if (measureShouldSkip(stack)) return { findings: [], bundleKb: null };
  // Bundle size needs somewhere to run the stack's build. Nothing runs
  // server-side any more, so this is a clean skip rather than a finding —
  // reporting "tool failed" on every audit would be noise, not a defect.
  if (!sandbox) return { findings: [], bundleKb: null };
  const command = getStack(stack).buildCommand;
  if (!command) return { findings: [], bundleKb: null };
  try {
    const built = await sandbox.runCommand(command);
    const output = `${built.stdout}\n${built.stderr}`;
    if (
      !built.success ||
      (/error|failed/i.test(output) &&
        /Failed to compile|Build failed|error during build/i.test(output))
    ) {
      const errorLine =
        output.split(/\r?\n/).find((line) => /error/i.test(line)) || output.slice(0, 400);
      const measure: BundleMeasure = {
        stack,
        ok: false,
        error: errorLine.trim(),
        assets: [],
        routeCount,
      };
      return { findings: findingsFromBundle(measure), bundleKb: null };
    }
    if (sandbox.writeFile) {
      await sandbox.writeFile('/tmp/navroop-measure-assets.cjs', MEASURE_SCRIPT);
    }
    const measured = await sandbox.runCommand('node /tmp/navroop-measure-assets.cjs');
    const assets = parseAssets(`${measured.stdout}\n${measured.stderr}`);
    const measure: BundleMeasure = { stack, ok: true, error: null, assets, routeCount };
    return { findings: findingsFromBundle(measure), bundleKb: totalBundleKb(assets) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      findings: findingsFromBundle({ stack, ok: false, error: message, assets: [], routeCount }),
      bundleKb: null,
    };
  }
}
