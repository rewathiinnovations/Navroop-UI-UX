import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { filesFromReply } from '@/lib/generation/parse-blocks';
import { summarizeGenerationOutput } from '@/lib/generation/output-summary';
import { toLastCode } from '@/lib/projects/last-code';
import { getCurrentProjectFiles } from '@/lib/github/current-files';
import { assemblePreview } from '@/lib/preview/assemble';
import { buildStablePromptPrefix } from '@/lib/stack-prompts';

const FENCE = '```';
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function source(relative: string) {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/**
 * One contract runs the whole pipeline: the model answers in path-tagged
 * fences, those become files, files become lastCode, and lastCode is what the
 * preview renders. A mismatch at any hop silently produces an empty site, so
 * this walks the whole chain rather than testing each end alone.
 */
describe('generation output contract', () => {
  it('asks for path-tagged fences, not XML file tags', () => {
    for (const stack of ['NEXTJS', 'REACT', 'STATIC_HTML']) {
      const prompt = buildStablePromptPrefix(stack, 'minimal');
      expect(prompt, `${stack} prompt`).toContain('{path=');
      expect(prompt, `${stack} prompt still shows XML`).not.toContain('<file path=');
    }
  });

  it('carries a reply through to a renderable preview', () => {
    const reply = [
      'Built a small landing page.',
      '',
      `${FENCE}tsx{path=src/App.tsx}`,
      "import { Hero } from './components/Hero';",
      'export default function App() { return <Hero />; }',
      FENCE,
      '',
      `${FENCE}tsx{path=src/components/Hero.tsx}`,
      'export function Hero() { return <h1>Ember &amp; Oak</h1>; }',
      FENCE,
    ].join('\n');

    const files = filesFromReply(reply);
    expect(Object.keys(files).sort()).toEqual(['src/App.tsx', 'src/components/Hero.tsx']);

    // Stored form, and back out again — the prose must not survive the round trip.
    const lastCode = toLastCode(files);
    expect(lastCode).not.toContain('Built a small landing page');
    const restored = getCurrentProjectFiles({ lastCode });
    expect(restored).toEqual(files);

    const assembly = assemblePreview('REACT', restored);
    expect(assembly.kind).toBe('bundle');
    if (assembly.kind !== 'bundle') return;
    expect(assembly.files[assembly.entry]).toContain("import Root from '/src/App.tsx'");
  });

  it('counts path-tagged fences separately from ordinary ones', () => {
    const summary = summarizeGenerationOutput(
      `Some prose with ${FENCE}js\ninline()\n${FENCE}\n${FENCE}tsx{path=src/App.tsx}\nconst a = 1;\n${FENCE}`,
    );
    // A reply with fences but no path-tagged ones is a model ignoring the
    // contract — indistinguishable from "produced nothing" without this split.
    expect(summary.pathFences).toBe(1);
    expect(summary.fences).toBe(4);
  });

  it('leaves no XML-format instructions in the generate route or examples', () => {
    for (const file of ['app/api/generate-ai-code-stream/route.ts', 'lib/edit-examples.ts']) {
      expect(source(file), `${file} still instructs XML output`).not.toContain('<file path="src');
    }
  });
});
