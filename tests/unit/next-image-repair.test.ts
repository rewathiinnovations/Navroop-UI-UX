import { describe, expect, it } from 'vitest';
import { describeImageConversions, fixNextImages } from '@/lib/generation/fix-next-image';
import { repairGeneratedFiles } from '@/lib/generation/deterministic-repairs';

/**
 * The prompt has asked for `next/image` on this stack for a long time. A
 * measured build produced nineteen files, six of them with a raw `<img>` and
 * none importing `next/image` at all — so the rule is applied here instead.
 *
 * The conversion cannot change what the preview shows: `lib/preview/assemble.ts`
 * shims `next/image` as a plain `<img>` passthrough. What it changes is the site
 * the user exports, publishes and deploys.
 */

describe('fixNextImages', () => {
  it('converts an img with intrinsic dimensions and adds the import', () => {
    const source = [
      'export default function Hero() {',
      '  return <img src="/uploads/a.webp" alt="Clinic" width={800} height={600} className="rounded-2xl" />;',
      '}',
    ].join('\n');
    const result = fixNextImages({ 'components/hero.tsx': source });
    const out = result.files['components/hero.tsx'];

    expect(out).toContain('import Image from "next/image";');
    expect(out).toContain('<Image');
    expect(out).not.toContain('<img');
    // Everything the element already said survives.
    expect(out).toContain('alt="Clinic"');
    expect(out).toContain('className="rounded-2xl"');
    expect(result.conversions).toEqual([{ file: 'components/hero.tsx', count: 1 }]);
  });

  it('folds the raw-HTML preload spelling into priority', () => {
    const result = fixNextImages({
      'a.tsx':
        '<img src="/a.webp" alt="" width={8} height={8} loading="eager" fetchPriority="high" />',
    });
    const out = result.files['a.tsx'];
    expect(out).toContain('priority');
    expect(out).not.toContain('loading="eager"');
    expect(out).not.toMatch(/fetchPriority/i);
  });

  it('leaves an img without intrinsic dimensions alone', () => {
    // next/image throws without width and height (or fill). An element that
    // crashes at runtime is far worse than an unoptimised one.
    const source = '<img src="/a.webp" alt="" />';
    expect(fixNextImages({ 'a.tsx': source }).files['a.tsx']).toBe(source);
  });

  it('leaves an img whose props are spread alone', () => {
    const source = '<img {...imageProps} width={8} height={8} src="/a.webp" alt="" />';
    expect(fixNextImages({ 'a.tsx': source }).files['a.tsx']).toBe(source);
  });

  it('places the import below a use client directive', () => {
    const result = fixNextImages({
      'a.tsx':
        '"use client";\n\nexport const A = () => <img src="/a.webp" alt="" width={8} height={8} />;',
    });
    const out = result.files['a.tsx'];
    // An import above the directive is a syntax error.
    expect(out.indexOf('"use client"')).toBeLessThan(out.indexOf('import Image'));
  });

  it('does not add a second import when one exists', () => {
    const result = fixNextImages({
      'a.tsx':
        'import Image from "next/image";\nexport const A = () => <img src="/a.webp" alt="" width={8} height={8} />;',
    });
    expect(result.files['a.tsx'].match(/from "next\/image"/g)).toHaveLength(1);
  });

  it('survives an attribute value containing a greater-than sign', () => {
    const source = '<img src="/a.webp" alt="" width={8} height={8} className={cn("a>b")} />';
    const out = fixNextImages({ 'a.tsx': source }).files['a.tsx'];
    expect(out).toContain('<Image');
    expect(out).toContain('cn("a>b")');
  });

  it('ignores the SVG image element', () => {
    const source = '<svg><image href="/a.svg" width="8" height="8" /></svg>';
    expect(fixNextImages({ 'a.tsx': source }).files['a.tsx']).toBe(source);
  });
});

describe('repairGeneratedFiles', () => {
  it('converts images only on the stack that has next/image', () => {
    const source = '<img src="/a.webp" alt="" width={8} height={8} />';
    expect(repairGeneratedFiles({ 'a.tsx': source }, 'REACT').files['a.tsx']).toBe(source);
    expect(repairGeneratedFiles({ 'a.tsx': source }, 'NEXTJS').files['a.tsx']).toContain('<Image');
  });

  it('applies both repairs to one file', () => {
    const result = repairGeneratedFiles(
      {
        'a.tsx':
          'import { Implant } from "lucide-react";\nexport const A = () => <><Implant /><img src="/a.webp" alt="" width={8} height={8} /></>;',
      },
      'NEXTJS',
    );
    expect(result.files['a.tsx']).toContain('Smile as Implant');
    expect(result.files['a.tsx']).toContain('<Image');
    expect(result.repairs.iconSubstitutions).toHaveLength(1);
    expect(result.repairs.imageConversions).toHaveLength(1);
  });
});

describe('describeImageConversions', () => {
  it('says nothing when nothing was converted', () => {
    expect(describeImageConversions([])).toBeNull();
  });

  it('counts elements and files', () => {
    const line = describeImageConversions([
      { file: 'a.tsx', count: 2 },
      { file: 'b.tsx', count: 1 },
    ]);
    expect(line).toContain('3 raw <img> elements');
    expect(line).toContain('2 files');
  });
});
