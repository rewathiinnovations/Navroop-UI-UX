import { describe, expect, it, vi } from 'vitest';
import { buildGenerationTools } from '@/lib/generation/tools';
import { createGenerationFileStore } from '@/lib/generation/tools/file-store';
import { assertWritableGenerationFile } from '@/lib/generation/write-guard';
import { SECTION_REGISTRY_NAMES } from '@/lib/stacks/section-registry';

/**
 * The catalogue as a contract the model is held to at the two moments it can be.
 *
 * Before this, the prompt named ten sections and described none of their props, so the model
 * inferred a shape from a component's name. Both ways of getting that wrong were invisible:
 * a misspelt prop is not an error esbuild can see, and an import of a section that does not
 * exist looks exactly like an import of a project file — the bundler reports "No matching
 * export" several steps after the mistake, if at all. `use_section` refuses the first at the
 * tool call; the write guard refuses the second at the one gate every write passes through.
 */

function toolset() {
  const store = createGenerationFileStore({
    stack: 'NEXTJS',
    files: {},
    designDirection: 'minimal',
  });
  const notify = vi.fn();
  return { tools: buildGenerationTools({ store, notify }), notify, store };
}

/** The AI SDK's tool shape: `execute` takes the parsed arguments. */
async function call(name: string, args: unknown) {
  const { tools, notify } = toolset();
  const tool = tools[name] as { execute: (input: unknown, opts?: unknown) => Promise<string> };
  const reply = await tool.execute(args, {});
  return { reply, notify };
}

describe('use_section returns something that compiles, or says why not', () => {
  it('fills in the content and hands back the imports with it', async () => {
    const { reply } = await call('use_section', {
      name: 'cta-band',
      content: { title: 'Start free', cta: { label: 'Create an account', href: '/signup' } },
    });

    expect(reply).toContain("import { CtaBand } from '@/components/sections/cta-band';");
    expect(reply).toContain('<CtaBand');
    expect(reply).toContain('Start free');
    expect(reply).toContain('/signup');
  });

  it('names the offending field rather than saying the input was invalid', async () => {
    // "Invalid input" costs a step and buys nothing: the retry guesses again.
    const { reply } = await call('use_section', {
      name: 'cta-band',
      content: { title: 'Start free', cta: { label: '' } },
    });

    expect(reply).toContain('does not match cta-band');
    expect(reply).toContain('cta.label');
  });

  it('reports a missing required field as missing', async () => {
    const { reply } = await call('use_section', {
      name: 'pricing-tiers',
      content: { title: 'Plans' },
    });
    expect(reply).toContain('tiers');
  });

  it('answers an unknown section with the whole catalogue', async () => {
    const { reply } = await call('use_section', { name: 'carousel', content: {} });

    expect(reply).toContain('no section called carousel');
    for (const name of SECTION_REGISTRY_NAMES) expect(reply).toContain(name);
  });

  it('records the refusal as a failed tool result, so the signal can count it', async () => {
    const { notify } = await call('use_section', { name: 'carousel', content: {} });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'result', tool: 'use_section', ok: false }),
    );
  });

  it('records a success as a successful result', async () => {
    const { notify } = await call('use_section', {
      name: 'stats-band',
      content: {
        items: [
          { value: '9', label: 'Operators' },
          { value: '4k', label: 'Sailings' },
        ],
      },
    });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'result', tool: 'use_section', ok: true }),
    );
  });

  it('includes an optional slot only when it is asked for, and says so if it cannot', async () => {
    const content = { title: 'Every crossing, one timetable' };
    const withMedia = await call('use_section', { name: 'hero', content, slots: ['media'] });
    expect(withMedia.reply).toContain('media={');

    const bogus = await call('use_section', { name: 'hero', content, slots: ['sidebar'] });
    expect(bogus.reply).toContain('Ignored unknown slot(s): sidebar');
  });

  it('writes nothing — the model still composes the page itself', async () => {
    const { tools, store } = toolset();
    const tool = tools.use_section as { execute: (i: unknown, o?: unknown) => Promise<string> };
    await tool.execute({ name: 'cta-band', content: { title: 'Go', cta: { label: 'Start' } } }, {});
    expect(store.writtenFiles()).toEqual({});
  });
});

describe('the write guard refuses a section that does not exist', () => {
  it('rejects an import of an invented section and names the catalogue', () => {
    expect(() =>
      assertWritableGenerationFile({
        path: 'app/page.tsx',
        content: "import { Carousel } from '@/components/sections/carousel';\n",
      }),
    ).toThrow(/carousel, which does not exist/);
  });

  it('accepts every section the kit actually ships', () => {
    for (const name of SECTION_REGISTRY_NAMES) {
      expect(() =>
        assertWritableGenerationFile({
          path: 'app/page.tsx',
          content: `import { X } from '@/components/sections/${name}';\n`,
        }),
      ).not.toThrow();
    }
  });

  it('is not fooled by an explicit file extension', () => {
    expect(() =>
      assertWritableGenerationFile({
        path: 'app/page.tsx',
        content: "import { Hero } from '@/components/sections/hero.tsx';\n",
      }),
    ).not.toThrow();
  });

  it('leaves imports from anywhere else alone', () => {
    expect(() =>
      assertWritableGenerationFile({
        path: 'app/page.tsx',
        content: [
          "import { Button } from '@/components/ui/button';",
          "import { Hero } from '@/components/marketing/hero';",
          "import Image from 'next/image';",
        ].join('\n'),
      }),
    ).not.toThrow();
  });
});
