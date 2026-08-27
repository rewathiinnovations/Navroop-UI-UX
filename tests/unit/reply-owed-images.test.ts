import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A model that asks for photographs in prose must be made to place them, not paid for them.
 *
 * Live reproduction (deepseek-v4-flash, NEXTJS, a cafe landing page). The model wanted four
 * pictures and wrote all four requests as prose lines in its reply instead of as the `src`
 * value of an image element. Measured on the finished project: eleven files with zero
 * `<img>`, zero `next/image` and zero `backgroundImage`, and `/api/projects/{id}/assets`
 * answering `{"assets":[]}` — a cafe landing page with no photographs.
 *
 * The round that tried to fix it made the settle *buy* those pictures. That left the page
 * exactly as empty, told the user to ask for them to be placed, and debited up to six image
 * credits for assets nothing referenced — on the default deployment, where no image worker
 * is configured and the paid provider path is live. Worse than the bug, with a bill.
 *
 * What is pinned here is the repair: one corrective ask that puts the token where the
 * contract says it goes, then the file-side fulfilment that already worked. And the floor
 * under it — when the ask is skipped, fails, or the model writes prose a second time, the
 * person is told in plain words that the page has no pictures, shown no protocol, and
 * billed for nothing.
 */

const images = vi.hoisted(() => ({
  generateImage: vi.fn(),
  imageWorkerConfig: vi.fn(),
  searchStockPhoto: vi.fn(),
  checkCredits: vi.fn(),
  consumeCredits: vi.fn(),
}));

vi.mock('@/lib/assets/generate-image', () => ({ generateImage: images.generateImage }));
vi.mock('@/lib/assets/image-worker', () => ({ imageWorkerConfig: images.imageWorkerConfig }));
vi.mock('@/lib/assets/stock-photo', () => ({ searchStockPhoto: images.searchStockPhoto }));
vi.mock('@/lib/plans/limits', () => ({
  checkCredits: images.checkCredits,
  consumeCredits: images.consumeCredits,
}));
vi.mock('@/lib/storage/usage', () => ({ WORKSPACE_ROW_ID: 'default', adjustStorageBytes: vi.fn() }));
vi.mock('@/lib/observability/track', () => ({ trackFailure: vi.fn() }));

import { fulfillNeedImages, imageFulfilmentNotice } from '@/lib/assets/fulfill';
import { stripNeedImageTokens } from '@/lib/assets/need-image';
import {
  classifyReplyOutcome,
  imagePlacementCorrection,
  imagesOwedByReply,
  imagesPlacedIn,
  IMAGE_PLACEMENT_RULES,
  MAX_CORRECTIVE_IMAGE_TOKENS,
  unplacedImagesAskedAgain,
  unplacedImagesNotice,
} from '@/lib/generation/no-changes';
import { filesFromReply } from '@/lib/generation/parse-blocks';
import { sanitizeGenerationPath } from '@/lib/generation/parse-files';
import { BASE_RULES } from '@/lib/stack-prompts/base-rules';
import { COMPLETION_RULES } from '@/lib/stack-prompts/shared';

const ROUTE = fileURLToPath(
  new URL('../../app/api/generate-ai-code-stream/route.ts', import.meta.url),
);

function routeSource() {
  return readFileSync(ROUTE, 'utf8');
}

/** The block the corrective ask lives in, as the route wiring tests slice it. */
function askBlock(source = routeSource()) {
  const at = source.indexOf('let askedForFilesAgain = false;');
  expect(at).toBeGreaterThan(0);
  return source.slice(at, source.indexOf('// Extract explanation', at));
}

/** The four requests, byte-for-byte as the live build wrote them. */
const PROSE_REQUESTS = [
  'NEED_IMAGE: Interior of a cozy tea cafe with warm lighting, wooden tables and hanging tea cups | 16:9 | Hero background',
  'NEED_IMAGE: Close-up of a glass cup of masala chai with spices visible, warm terracotta tones | 1:1 | About section',
  'NEED_IMAGE: Wide shot of a tea cafe counter with brass kettle and ceramic cups | 16:9 | Menu section background',
  'NEED_IMAGE: Open graph image with Chai Point branding on warm terracotta background | 1200x630',
];

/**
 * The reply as it arrived: real files, and every picture request left in the prose around
 * them. Two files rather than eleven — the count was never the fault.
 */
const PROSE_REPLY = [
  'I have built the Chai Point landing page with a hero, an about section and a menu.',
  '',
  '```tsx{path=app/page.tsx}',
  'export default function Page() {',
  '  return (',
  '    <main>',
  '      <h1>Chai Point</h1>',
  '      <section id="about">Masala chai, brewed the long way.</section>',
  '    </main>',
  '  );',
  '}',
  '```',
  '',
  '```ts{path=app/layout.tsx}',
  "export const metadata = { title: 'Chai Point' };",
  'export default function Layout({ children }: { children: React.ReactNode }) {',
  '  return <html lang="en"><body>{children}</body></html>;',
  '}',
  '```',
  '',
  'The images this page needs:',
  ...PROSE_REQUESTS,
].join('\n');

/** The same reply's files, parsed the way the route parses them. */
function filesOf(reply: string): { path: string; content: string }[] {
  return Object.entries(filesFromReply(reply)).flatMap(([path, content]) => {
    const safe = sanitizeGenerationPath(path);
    return safe.ok ? [{ path: safe.path, content }] : [];
  });
}

/** What the corrective ask asks for: the same two files, with the tokens in a `src`. */
const CORRECTED_REPLY = [
  'Placing them now.',
  '',
  '```tsx{path=app/page.tsx}',
  'export default function Page() {',
  '  return (',
  '    <main>',
  '      <h1>Chai Point</h1>',
  `      <img src="${PROSE_REQUESTS[0].replace(' | Hero background', '')}" alt="" width="1600" height="900" />`,
  `      <img src="${PROSE_REQUESTS[1].replace(' | About section', '')}" alt="" width="1200" height="1200" />`,
  `      <img src="${PROSE_REQUESTS[2].replace(' | Menu section background', '')}" alt="" width="1600" height="900" />`,
  '    </main>',
  '  );',
  '}',
  '```',
  '',
  '```ts{path=app/layout.tsx}',
  "export const metadata = {",
  "  title: 'Chai Point',",
  `  openGraph: { images: ['${PROSE_REQUESTS[3]}'] },`,
  '};',
  'export default function Layout({ children }: { children: React.ReactNode }) {',
  '  return <html lang="en"><body>{children}</body></html>;',
  '}',
  '```',
].join('\n');

/** The second miss: told to place them, the model describes them again. */
const STILL_PROSE_REPLY = [
  'Understood. Here are the images again, ready for you to add:',
  '',
  '```tsx{path=app/page.tsx}',
  'export default function Page() {',
  '  return <main><h1>Chai Point</h1></main>;',
  '}',
  '```',
  '',
  ...PROSE_REQUESTS,
].join('\n');

const PROJECT = 'p-chai-point';
const USER = 'u-chai-point';
const CDN = 'https://cdn.example.com/chai.png';

beforeEach(() => {
  vi.clearAllMocks();
  // The operator's own worker: free, unmetered, and the path a configured deployment
  // takes. Nothing here should reach the credit ledger either way.
  images.imageWorkerConfig.mockResolvedValue({
    url: 'https://worker.example.com',
    token: 't',
    model: 'lucid-origin',
  });
  images.generateImage.mockResolvedValue({ url: CDN, provider: 'worker' });
});

describe('the prose reply is read as four pictures the page does not have', () => {
  it('owes every request the files never carried', () => {
    const owed = imagesOwedByReply({ reply: PROSE_REPLY, files: filesOf(PROSE_REPLY) });

    expect(owed).toHaveLength(4);
    expect(owed.map((directive) => directive.aspect)).toEqual(['16:9', '1:1', '16:9', '1200x630']);
    // The description stops at the first `|`; the placement note is annotation, and
    // handing the whole tail to the aspect matcher is what reframed a square portrait
    // as a 16:9 default.
    expect(owed[1].description).toBe(
      'Close-up of a glass cup of masala chai with spices visible, warm terracotta tones',
    );
  });

  it('owes nothing when the same request already sits in a src', () => {
    // The contract being met is not a complaint. This is the whole difference between
    // asking the model to fix its own output and buying pictures behind its back.
    expect(imagesOwedByReply({ reply: CORRECTED_REPLY, files: filesOf(CORRECTED_REPLY) })).toEqual(
      [],
    );
  });

  it('owes nothing for a reply that changed nothing', () => {
    // A question is an answer, and an answer owes no pictures. Starting a second
    // generation over one is the false failure `classifyReplyOutcome` exists to stop.
    const asking = `Which hero shot did you have in mind? Something like ${PROSE_REQUESTS[0]}?`;
    expect(classifyReplyOutcome({ fileCount: 0, reply: asking, askedAgain: false })).toBe('answer');
    // The route never reads the directives out of such a reply: an answer sends no files
    // and owes none, so the guard runs ahead of the parser rather than after it.
    expect(askBlock()).toMatch(
      /files\.length > 0 \|\| owedFiles \? imagesOwedByReply\(\{ reply: generatedCode, files \}\) : \[\]/,
    );
  });
});

describe('the corrective ask is one turn, and it carries both complaints', () => {
  it('fires for owed pictures as well as for owed files, and at most once', () => {
    const block = askBlock();
    // One gate, two reasons — not two consecutive corrective streams on one build.
    expect(block).toMatch(/\(owedFiles \|\| owedImages\.length > 0\)/);
    expect(block).toMatch(/imagesOwedByReply\(\{ reply: generatedCode, files \}\)/);
    // The single spend marker, set once and read by the final classification, so a
    // second miss is reported rather than asked again.
    expect(routeSource().match(/askedForFilesAgain = true;/g)).toHaveLength(1);
    expect(routeSource().match(/imagePlacementCorrection\(/g)).toHaveLength(1);
  });

  it('goes back to the provider that just answered, and charges nothing more', () => {
    const source = routeSource();
    const block = askBlock(source);
    // Not failover: a model that talked is a working vendor, and walking the chain pays
    // a second one to repeat the mistake. Asserted on the entry the ask is built from
    // rather than on the client helper's name, which is edited often.
    expect(block).toMatch(/correctiveEntry, providerEnv, correctiveEntry\.model/);
    expect(block).not.toMatch(/executeWithCompletionFailover/);
    // The job's one charge happened before the first call; the ask is part of that job.
    expect(source.match(/await markJobRunning\(/g)).toHaveLength(1);
    // And it reaches no image provider at all. Buying a picture nothing references is
    // the spend this whole change exists to stop.
    expect(source).not.toMatch(/fulfillNeedImagesFromReply/);
  });

  it('is skipped when nobody is listening, and records the miss on the job', () => {
    const block = askBlock();
    expect(block).toMatch(/!clientDisconnected/);
    expect(block).toMatch(/key: 'place-images'/);
    expect(block).toMatch(/MISSING_IMAGES_STEP_ERROR/);
    // Same discipline as the files half: the captured stream error is surfaced and the
    // per-job token cap still applies to the second stream.
    expect(block).toMatch(/surfaceStreamFailure\(/);
    expect(block).toMatch(/capTracker\.addChunk\(/);
  });

  it('quotes the prompt’s own rules instead of describing them a second time', () => {
    const correction = imagePlacementCorrection(
      imagesOwedByReply({ reply: PROSE_REPLY, files: filesOf(PROSE_REPLY) }),
    );

    // Two descriptions of one contract drift apart, and the model then satisfies
    // whichever one it happened to read.
    expect(IMAGE_PLACEMENT_RULES).not.toBe('');
    expect(BASE_RULES).toContain(IMAGE_PLACEMENT_RULES);
    expect(correction).toContain(IMAGE_PLACEMENT_RULES);
    expect(correction).toContain(COMPLETION_RULES);
    // The requests handed back in the canonical shape the file scanner reads — bounded
    // description, an aspect the pipeline can actually produce, no placement note.
    expect(correction).toContain(
      'NEED_IMAGE: Open graph image with Chai Point branding on warm terracotta background | 1200x630',
    );
    expect(correction).not.toContain('| Hero background');
    expect(correction).toMatch(/src value/i);
    expect(correction).toMatch(/do not ask a question/i);
  });

  it('lists no more requests than the ceiling, however many the reply wished for', () => {
    const reply = Array.from(
      { length: MAX_CORRECTIVE_IMAGE_TOKENS + 5 },
      (_unused, index) => `NEED_IMAGE: shopfront number ${index} | 16:9`,
    ).join('\n');
    const owed = imagesOwedByReply({ reply, files: [] });

    expect(owed).toHaveLength(MAX_CORRECTIVE_IMAGE_TOKENS + 5);
    const listed = imagePlacementCorrection(owed).split('NEED_IMAGE: shopfront number').length - 1;
    expect(listed).toBe(MAX_CORRECTIVE_IMAGE_TOKENS);
  });
});

describe('a corrected reply with the tokens in a src puts pictures on the page', () => {
  it('counts every owed request as placed', () => {
    const owed = imagesOwedByReply({ reply: PROSE_REPLY, files: filesOf(PROSE_REPLY) });
    expect(imagesPlacedIn(filesOf(CORRECTED_REPLY), owed)).toBe(4);
  });

  it('leaves nothing owed once the two replies are merged the way the route merges them', () => {
    const owed = imagesOwedByReply({ reply: PROSE_REPLY, files: filesOf(PROSE_REPLY) });
    // The route appends the correction and lets `filesFromReply` pick the later block,
    // so the corrected file replaces its twin and the untouched ones survive.
    const merged = `${PROSE_REPLY}\n\n${CORRECTED_REPLY}`;
    expect(Object.keys(filesFromReply(merged)).sort()).toEqual(['app/layout.tsx', 'app/page.tsx']);
    expect(imagesPlacedIn(filesOf(merged), owed)).toBe(4);
    expect(imagesOwedByReply({ reply: merged, files: filesOf(merged) })).toEqual([]);
  });

  it('turns those tokens into real asset URLs, with no raw token left behind', async () => {
    const out = await fulfillNeedImages({
      projectId: PROJECT,
      userId: USER,
      files: filesOf(CORRECTED_REPLY),
    });

    expect(out.requested).toBe(4);
    expect(out.fulfilled).toBe(4);
    expect(out.unfulfilled).toEqual([]);
    for (const file of out) expect(file.content).not.toContain('NEED_IMAGE');
    expect(out[0].content).toContain(CDN);
  });
});

describe('a second helping of prose is reported, not adopted and not bought', () => {
  it('refuses the corrected reply that placed none of them', () => {
    const owed = imagesOwedByReply({ reply: PROSE_REPLY, files: filesOf(PROSE_REPLY) });
    expect(imagesPlacedIn(filesOf(STILL_PROSE_REPLY), owed)).toBe(0);
    // Taking that reply would swap the files the user watched arrive for whatever the
    // nudge resent, and still leave the page without a photograph. Judged per complaint,
    // so a reply that owed files *and* pictures still keeps the files it finally sent.
    expect(askBlock()).toMatch(
      /if \(!owedFiles && owedImages\.length > 0 && placedImages === 0\)/,
    );
  });

  it('spends no image credits on pictures the page does not reference', async () => {
    const out = await fulfillNeedImages({
      projectId: PROJECT,
      userId: USER,
      files: filesOf(STILL_PROSE_REPLY),
    });

    // Fulfilment sees a file set with no token in it, so there is nothing to buy. This is
    // the whole trade: the request survives as a sentence in chat, not as a debit.
    expect(out.requested).toBe(0);
    expect(images.generateImage).not.toHaveBeenCalled();
    expect(images.searchStockPhoto).not.toHaveBeenCalled();
    expect(images.checkCredits).not.toHaveBeenCalled();
    expect(images.consumeCredits).not.toHaveBeenCalled();
  });

  it('tells the person in plain words, with none of the protocol in it', () => {
    const notice = unplacedImagesNotice({ count: 4, asked: true });

    expect(notice).toContain('4 images');
    expect(notice).toMatch(/no photographs/i);
    expect(notice).toMatch(/asked again/i);
    // The `NEED_IMAGE:` lines are stripped from the transcript; naming them here would
    // put back exactly what the strip removes.
    expect(notice).not.toContain('NEED_IMAGE');
    expect(notice).not.toMatch(/token/i);
    expect(notice).not.toMatch(/src\b/);
    // Nothing was bought, so nothing may be claimed to exist.
    expect(notice).not.toMatch(/added to assets/i);

    // The ask can also be skipped outright — a departed client — and then it did not
    // happen and must not be described as though it had.
    expect(unplacedImagesNotice({ count: 1, asked: false })).not.toMatch(/asked again/i);
    expect(unplacedImagesNotice({ count: 1, asked: false })).toMatch(/no photograph there/i);
  });

  it('is the sentence the route sends, after the ask rather than instead of it', () => {
    const source = routeSource();
    const noticeAt = source.indexOf('unplacedImagesNotice({');
    expect(noticeAt).toBeGreaterThan(source.indexOf('let askedForFilesAgain = false;'));
    // Read off the final reply and the final file list, so a correction that worked says
    // nothing at all here.
    const before = source.slice(noticeAt - 1200, noticeAt);
    expect(before).toMatch(
      /const unplacedImages = imagesOwedByReply\(\{ reply: generatedCode, files \}\)/,
    );
    expect(before).toMatch(/type: 'warning'/);
    // The settle counts the same requests off the same final reply and has its own
    // sentence for them, so this one speaks only when that sentence did not arrive.
    // One fact, one line — the transcript must not say it twice.
    expect(before).toMatch(/if \(!streamSettle\?\.imageNotice\) \{/);
    // Logged either way: `asked` is the half only this side knows, and it is how anyone
    // tells whether the corrective ask is working.
    expect(before).toMatch(/generation\.images_unplaced/);
    expect(before).toMatch(/asked: askedToPlaceImages/);
  });

  it('says the ask went out without quoting it', () => {
    const line = unplacedImagesAskedAgain(4);
    expect(line).toContain('4 images');
    expect(line).not.toContain('NEED_IMAGE');
  });
});

describe('the transcript and the stored files still refuse the raw token', () => {
  it('leaves no directive line in the assistant’s own words', () => {
    // Round 2/3 behaviour, pinned here because the corrective ask reads the same reply
    // the scrubber cleans and a regression would put four lines of internal protocol
    // back in the customer's first build.
    const spoken = stripNeedImageTokens(PROSE_REPLY);
    expect(spoken).not.toContain('NEED_IMAGE');
    expect(spoken).toContain('I have built the Chai Point landing page');
    // A line that was only a directive was never speech, so it leaves entirely.
    expect(spoken).not.toContain('Hero background');
  });

  it('no longer tells the customer to place the pictures itself', async () => {
    // The delegation this change removes: the pictures existed as rows in the Assets tab
    // and the site they were bought for shipped with no `<img>` at all, and the chat
    // handed the repair back to the person who asked for a finished page.
    const notice = imageFulfilmentNotice({ fromReply: 2, unfulfilled: 0 });
    expect(notice).not.toMatch(/ask for (it|them) to be placed/i);
    expect(notice).toMatch(/not on the page/i);
  });
});
