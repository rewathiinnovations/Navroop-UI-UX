/**
 * Input that is validated, not merely cast.
 *
 *   - F-742: `z.string().url()` validates by constructing `new URL(value)`,
 *     which accepts EVERY scheme. `javascript:`, `file:` and `data:` passed
 *     avatar and template validation and were persisted, then served back to
 *     clients — inert in an `<img src>` today, XSS the moment either value is
 *     rendered as an `<a href>`. The `data:` avatar branch also had no length
 *     cap and no MIME allowlist, and `listRecentPresence` re-sends `avatarUrl`
 *     to every workspace member every 30 seconds.
 *   - F-743: `readGenerationInput` cast `style`, `previewUrl`, `lastCode` and
 *     `progressMessage` with `as string | null | undefined`, so
 *     `PATCH /api/projects/[id]` with `{"lastCode": {"a": 1}}` reached
 *     `prisma.project.update` and surfaced as a 500 instead of a 400 naming the
 *     field — with no length bound on the project's stored site content.
 *
 * Every block below failed against the pre-fix code.
 */
import { describe, expect, it } from 'vitest';
import { httpUrl } from '@/lib/schema/url';
import { updateProfileSchema } from '@/lib/profile/schema';
import { adminTemplateSchema, saveTemplateSchema } from '@/lib/templates/schema';
import { readGenerationInput } from '@/lib/projects/http';

const HOSTILE_SCHEMES = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  ' javascript:alert(1)',
  'file:///etc/passwd',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'blob:https://navroop.app/1234',
  'ftp://example.invalid/x',
];

describe('httpUrl accepts only http and https (F-742)', () => {
  const schema = httpUrl(500);

  it('accepts http and https', () => {
    expect(schema.safeParse('https://example.invalid/a').success).toBe(true);
    expect(schema.safeParse('http://example.invalid/a').success).toBe(true);
  });

  for (const hostile of HOSTILE_SCHEMES) {
    it(`rejects ${JSON.stringify(hostile)}`, () => {
      expect(schema.safeParse(hostile).success).toBe(false);
    });
  }

  it('rejects a value over the length cap', () => {
    expect(schema.safeParse(`https://example.invalid/${'a'.repeat(500)}`).success).toBe(false);
  });

  it('rejects something that is not a URL at all', () => {
    expect(schema.safeParse('not a url').success).toBe(false);
  });
});

describe('avatarUrl (F-742)', () => {
  for (const hostile of HOSTILE_SCHEMES) {
    it(`rejects ${JSON.stringify(hostile)}`, () => {
      expect(updateProfileSchema.safeParse({ avatarUrl: hostile }).success).toBe(false);
    });
  }

  it('rejects a data: URI — uploadAvatar stores real files, so nothing sends one', () => {
    const parsed = updateProfileSchema.safeParse({
      avatarUrl: `data:image/png;base64,${'A'.repeat(4_000)}`,
    });
    expect(parsed.success).toBe(false);
  });

  it('still accepts an https URL, an /uploads/ path, empty and null', () => {
    for (const allowed of ['https://cdn.example.invalid/a.png', '/uploads/avatars/a.png', '']) {
      expect(updateProfileSchema.safeParse({ avatarUrl: allowed }).success, allowed).toBe(true);
    }
    expect(updateProfileSchema.safeParse({ avatarUrl: null }).success).toBe(true);
  });

  it('normalises the empty string to null, as before', () => {
    const parsed = updateProfileSchema.safeParse({ avatarUrl: '' });
    expect(parsed.success && parsed.data.avatarUrl).toBeNull();
  });
});

describe('template previewUrl (F-742)', () => {
  // A payload that is valid apart from `previewUrl`, so a rejection below is
  // attributable to the scheme and not to a missing required field.
  const base = {
    name: 'Demo',
    description: 'A demo template',
    category: 'business',
    prompt: 'Build a demo marketing site with a hero and a contact form.',
  } as const;

  type ParseOutcome =
    { success: true } | { success: false; error: { issues: { path: PropertyKey[] }[] } };
  const previewUrlIssue = (result: ParseOutcome) =>
    !result.success && result.error.issues.some((issue) => issue.path.includes('previewUrl'));

  it('the base payload is valid on its own (anti-vacuity)', () => {
    expect(saveTemplateSchema.safeParse(base).success).toBe(true);
    expect(adminTemplateSchema.safeParse(base).success).toBe(true);
  });

  for (const hostile of HOSTILE_SCHEMES) {
    it(`rejects ${JSON.stringify(hostile)} on previewUrl in both schemas`, () => {
      expect(previewUrlIssue(saveTemplateSchema.safeParse({ ...base, previewUrl: hostile }))).toBe(
        true,
      );
      expect(previewUrlIssue(adminTemplateSchema.safeParse({ ...base, previewUrl: hostile }))).toBe(
        true,
      );
    });
  }

  it('still accepts an https preview URL, the empty string and null', () => {
    expect(
      saveTemplateSchema.safeParse({ ...base, previewUrl: 'https://demo.invalid/' }).success,
    ).toBe(true);
    expect(saveTemplateSchema.safeParse({ ...base, previewUrl: '' }).success).toBe(true);
    expect(adminTemplateSchema.safeParse({ ...base, previewUrl: null }).success).toBe(true);
  });
});

describe('readGenerationInput parses instead of casting (F-743)', () => {
  it('refuses a non-string lastCode with a 400 naming the field', () => {
    const result = readGenerationInput({ lastCode: { a: 1 } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(400);
    expect(result.error.toLowerCase()).toContain('lastcode');
  });

  it('refuses a non-string previewUrl and a non-http(s) one', () => {
    expect(readGenerationInput({ previewUrl: 12345 }).ok).toBe(false);
    expect(readGenerationInput({ previewUrl: 'javascript:alert(1)' }).ok).toBe(false);
  });

  it('refuses an unknown generationStatus rather than storing it', () => {
    // The pre-fix code took `generationStatus` verbatim when it was any string
    // and only allowlisted the legacy `status` alias.
    expect(readGenerationInput({ generationStatus: 'whatever' }).ok).toBe(false);
    expect(readGenerationInput({ status: 'whatever' }).ok).toBe(true);
  });

  it('bounds lastCode instead of storing an arbitrarily large blob', () => {
    const result = readGenerationInput({ lastCode: 'x'.repeat(20_000_000) });
    expect(result.ok).toBe(false);
  });

  it('accepts the payload the workspace actually sends', () => {
    const result = readGenerationInput({
      style: 'minimal',
      model: 'deepseek-v4-pro',
      previewUrl: 'https://preview-static.navroop.app/p1?t=abc',
      screenshot: 'https://cdn.firecrawl.invalid/shot.png',
      status: 'ready',
      progressMessage: 'Building…',
      sourceMessage: 'make it blue',
      source: 'chat',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data.thumbnailUrl).toBe('https://cdn.firecrawl.invalid/shot.png');
    expect(result.data.generationStatus).toBe('ready');
    expect(result.data.style).toBe('minimal');
  });

  it('keeps the model rules it already had (F-003/F-004)', () => {
    const offered = readGenerationInput({ model: 'deepseek-v4-pro' });
    expect(offered.ok && offered.data.model).toBe('deepseek-v4-pro');
    const stale = readGenerationInput({ model: 'deepseek-reasoner' });
    expect(stale.ok && stale.data.model).toBeNull();
    const absent = readGenerationInput({});
    expect(absent.ok && absent.data.model).toBeUndefined();
  });

  it('still drops fields Project no longer has, rather than 400ing on them', () => {
    // `sandboxId` is what the client sent for weeks after the column was
    // dropped. Rejecting it would turn every legacy client's persist into a
    // 400; the contract is that unknown keys are ignored, known ones validated.
    const result = readGenerationInput({ sandboxId: 'sbx_1', progressMessage: 'x' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect('sandboxId' in result.data).toBe(false);
  });
});
