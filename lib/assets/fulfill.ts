import { generateImage } from '@/lib/assets/generate-image';
import { imageWorkerConfig } from '@/lib/assets/image-worker';
import {
  needImageKey,
  parseNeedImageDirectives,
  placeholderReplacements,
  replaceNeedImageTokens,
  sweepNeedImageTokens,
  type NeedImageAspect,
  type NeedImageDirective,
} from '@/lib/assets/need-image';
import { searchStockPhoto, type StockPhotoRun } from '@/lib/assets/stock-photo';
import { trackFailure } from '@/lib/observability/track';
import { checkCredits, consumeCredits } from '@/lib/plans/limits';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';

export type FulfillableFile = { path: string; content: string };

/** One NEED_IMAGE token that ended as a placeholder, and why. */
export type UnfulfilledImage = {
  description: string;
  aspect: NeedImageAspect;
  reason: string;
};

/**
 * The rewritten files, plus the tokens no provider could fill.
 *
 * An array carrying one extra property rather than a `{ files, unfulfilled }`
 * object, so existing callers that map over the result keep working. The count
 * exists because an unfulfilled token used to be a `console.warn` and nothing
 * else: the site shipped a grey panel, the user was told the build succeeded,
 * and a missing photo was indistinguishable from a bug. With a provider
 * configured, a placeholder now means a real failure — rate limit, network or
 * storage — which is exactly when the user has to be told.
 */
export type FulfilledFiles = FulfillableFile[] & {
  /** Distinct directives the parser found across the batch. */
  requested: number;
  /** How many became a real asset URL. `requested - fulfilled === unfulfilled.length`. */
  fulfilled: number;
  unfulfilled: UnfulfilledImage[];
};

export async function fulfillNeedImages(input: {
  projectId: string;
  userId?: string | null;
  files: FulfillableFile[];
  sourceOverride?: 'stock' | 'generated';
}): Promise<FulfilledFiles> {
  const combined = input.files.map((file) => file.content).join('\n');
  const directives = parseNeedImageDirectives(combined);
  // The early return is still an exit through the module's floor: a token the
  // parser cannot read (`NEED_IMAGE:|16:9`, an empty description) reaches no
  // provider, so there is nothing to fulfil — but `withPlaceholdersForUnfulfilled`
  // is also where `sweepNeedImageTokens` lives, and skipping it shipped the raw
  // token. Sweeping here makes the guarantee self-contained rather than
  // dependent on a second caller re-applying it (F-128).
  if (directives.length === 0) {
    const swept = input.files.map((file) => ({
      path: file.path,
      content: withPlaceholdersForUnfulfilled(file.content),
    }));
    return Object.assign(swept, { requested: 0, fulfilled: 0, unfulfilled: [] });
  }

  const resolved = await resolveDirectives({
    directives,
    projectId: input.projectId,
    userId: input.userId,
    sourceOverride: input.sourceOverride,
  });

  // One image, every place that asked for it. The directive carries each occurrence
  // exactly as it was written, because two requests that differ only by a placement
  // note — `… | 1:1` and `… | 1:1 | About section` — dedupe to one picture, and
  // rewriting only the text of the first left the second's annotation tail inside
  // the `src`.
  const replacements = resolved.fulfilled.flatMap(({ directive, url }) =>
    directive.tokens.map((token) => ({ token, url })),
  );
  const files = input.files.map((file) => ({
    path: file.path,
    content: withPlaceholdersForUnfulfilled(replaceNeedImageTokens(file.content, replacements)),
  }));
  return Object.assign(files, {
    requested: directives.length,
    fulfilled: resolved.fulfilled.length,
    unfulfilled: resolved.unfulfilled,
  });
}

/**
 * The whole provider chain for a list of directives, with nothing about files in it.
 *
 * Split out of `fulfillNeedImages` when the reply-sourced path arrived: the worker
 * lookup, the three-at-a-time batching, the per-run stock refusal memory and the
 * credit accounting are the parts that must not be written twice, and a second copy
 * of them would be a second place for "one 429 stops the rest of this generation"
 * to stop being true.
 */
async function resolveDirectives(input: {
  directives: NeedImageDirective[];
  projectId: string;
  userId?: string | null;
  sourceOverride?: 'stock' | 'generated';
}): Promise<{
  /** One entry per directive that became a real asset — never one per token. */
  fulfilled: Array<{ directive: NeedImageDirective; url: string }>;
  unfulfilled: UnfulfilledImage[];
}> {
  // Shared across directives so a provider that has refused for the whole
  // generation is skipped for the rest of it rather than asked again per image.
  const run: StockPhotoRun = {};
  const worker = input.sourceOverride === 'stock' ? null : await imageWorkerConfig();

  // Generation runs three at a time: the worker takes about twelve seconds per
  // image, so a six-image site would otherwise add over a minute to every build.
  const generated = await inBatches(input.directives, 3, (directive) =>
    attemptGeneration({
      directive,
      projectId: input.projectId,
      userId: input.userId,
      skip: input.sourceOverride === 'stock',
      workerConfigured: Boolean(worker),
    }),
  );

  const fulfilled: Array<{ directive: NeedImageDirective; url: string }> = [];
  const unfulfilled: UnfulfilledImage[] = [];
  for (const outcome of generated) {
    // Stock fallbacks are deliberately serial while generation is parallel. The
    // whole point of `run` is that one 429 stops the rest of this generation from
    // asking again, and two simultaneous requests both miss that record — which
    // is exactly what a rate-limit test caught after the first attempt here.
    const settled = outcome.url
      ? outcome
      : await tryStock(
          { directive: outcome.directive, projectId: input.projectId, run },
          outcome.reason ?? 'no image provider answered',
        );

    if (settled.url) {
      fulfilled.push({ directive: settled.directive, url: settled.url });
      continue;
    }
    console.warn('[assets] NEED_IMAGE unfulfilled:', settled.directive.description, settled.reason);
    unfulfilled.push({
      description: settled.directive.description,
      aspect: settled.directive.aspect,
      reason: settled.reason ?? 'no image provider answered',
    });
  }
  return { fulfilled, unfulfilled };
}

/**
 * How many prose-sourced pictures one reply may buy.
 *
 * The file path is bounded by the site itself — a token has to sit in a `src` to
 * count. Reply text has no such bound, so a chatty model listing fifteen "nice to
 * have" images would spend fifteen image credits (or twenty-five worker-minutes)
 * on pictures nothing references yet. Six covers a hero, an about shot, a section
 * background and an og:image with room to spare.
 */
export const MAX_REPLY_SOURCED_IMAGES = 6;

/**
 * The shape {@link fulfillNeedImagesFromReply} answers with. Not exported: nothing
 * outside this module reads it any more — see that function's note on why it has no
 * production caller left. `MAX_REPLY_SOURCED_IMAGES` above stays exported because it is
 * a spend ceiling, and a ceiling wants a test that fails when someone raises it.
 */
type ReplyImageFulfilment = {
  /** Distinct directives found in the reply that the file pass had not already taken. */
  requested: number;
  /** How many of those were actually attempted, after {@link MAX_REPLY_SOURCED_IMAGES}. */
  attempted: number;
  /** How many became a real, stored asset. */
  fulfilled: number;
  unfulfilled: UnfulfilledImage[];
};

/**
 * Buy the picture requests a model wrote as prose instead of into a `src`.
 *
 * **Nothing in the product calls this any more, and nothing should.** It was the answer
 * to a live build (deepseek-v4-flash, NEXTJS) that put all four of its requests in the
 * conversational reply: `fulfillNeedImages` scans file contents only, so the finished
 * cafe landing page had zero `<img>`, zero `next/image` and an empty `/assets` response.
 * Buying the pictures did not fix that. There is no token to rewrite here, so a fulfilled
 * request is a `ProjectAsset` row and nothing else — the page stayed exactly as empty,
 * the chat asked the customer to place them, and with no image worker configured (the
 * `docker-compose.yml` default) each one debited a real image credit. A page with no
 * photographs is a smaller failure than a page with no photographs and a bill.
 *
 * The repair now lives where the mistake is: the generate route asks the model once to
 * write the token into a `src` (`imagePlacementCorrection`, lib/generation/no-changes.ts),
 * and the file pass above places it. What is left unplaced is counted and said out loud,
 * never bought.
 *
 * Kept only because `tests/unit/need-image-one-picture-two-placements.test.ts` still
 * exercises it; delete both together.
 *
 * `alreadyHandled` is the file pass's directive list: the same picture asked for
 * in both places is one picture, and paying for it twice is exactly the failure
 * `needImageKey` exists to prevent.
 */
export async function fulfillNeedImagesFromReply(input: {
  projectId: string;
  userId?: string | null;
  text: string;
  alreadyHandled?: NeedImageDirective[];
  limit?: number;
}): Promise<ReplyImageFulfilment> {
  const handled = new Set((input.alreadyHandled ?? []).map(needImageKey));
  // Parsed as prose, which is the whole reason this function exists: a reply is not
  // a file, so a directive ends at the end of its line and an apostrophe in
  // `a barista's hands pouring chai | 1:1` is part of the subject. Read with the
  // file terminators it parsed as "a barista" at the default 16:9, and the credit
  // bought a picture of neither the subject nor the shape that was asked for.
  const directives = parseNeedImageDirectives(input.text, 'prose').filter(
    (directive) => !handled.has(needImageKey(directive)),
  );
  if (directives.length === 0) {
    return { requested: 0, attempted: 0, fulfilled: 0, unfulfilled: [] };
  }

  const limit = Math.max(0, input.limit ?? MAX_REPLY_SOURCED_IMAGES);
  const attempted = directives.slice(0, limit);
  if (attempted.length === 0) {
    return { requested: directives.length, attempted: 0, fulfilled: 0, unfulfilled: [] };
  }

  const resolved = await resolveDirectives({
    directives: attempted,
    projectId: input.projectId,
    userId: input.userId,
  });
  return {
    requested: directives.length,
    attempted: attempted.length,
    fulfilled: resolved.fulfilled.length,
    unfulfilled: resolved.unfulfilled,
  };
}

/**
 * The sentence chat gets in place of the protocol lines that were stripped out of it.
 *
 * Deleting the request lines without saying anything trades one silent failure for
 * another: the person asked for a cafe page, four photographs were requested, and
 * nothing anywhere told them why the page has none. Names the count and where the
 * pictures went; the reasons stay in the log, because "image credits denied
 * (period_exhausted)" is not a sentence for a chat transcript.
 *
 * `unfulfilled` is the live half: a token that did reach a `src` and that no provider
 * could serve. `fromReply` counts pictures created out of a request the model wrote as
 * prose, and the settle passes 0 for it now — nothing on that path buys one any more, so
 * in production this branch does not run. It is kept, rather than dropped, because the
 * parameter is what a caller would reach for the moment reply-sourced fulfilment came
 * back, and it must not come back saying "ask for them to be placed on the page": handing
 * the repair to the customer is what made those pictures worth nothing, rows in the Assets
 * tab against a site that still shipped with no `<img>` at all. The repair is the generate
 * route's corrective ask — it makes the model write the token into a `src`, where
 * fulfilment places it — so all this sentence may claim is where the pictures ended up.
 */
export function imageFulfilmentNotice(input: {
  fromReply: number;
  unfulfilled: number;
}): string | null {
  const parts: string[] = [];
  if (input.fromReply > 0) {
    parts.push(
      input.fromReply === 1
        ? 'The AI described 1 image in its reply instead of placing it in the code, so it is in the Assets tab but not on the page.'
        : `The AI described ${input.fromReply} images in its reply instead of placing them in the code, so they are in the Assets tab but not on the page.`,
    );
  }
  if (input.unfulfilled > 0) {
    parts.push(
      input.unfulfilled === 1
        ? 'One image could not be produced, so the page shows a plain panel where it belongs. Check the image provider settings, or upload your own from the Assets tab.'
        : `${input.unfulfilled} images could not be produced, so the page shows plain panels where they belong. Check the image provider settings, or upload your own from the Assets tab.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

type DirectiveOutcome = {
  directive: NeedImageDirective;
  url?: string;
  reason?: string;
};

/**
 * One attempt at generating a picture; no stock fallback lives here.
 *
 * The worker is the operator's own endpoint, so it is free and needs no user key
 * — which is why nothing here meters it. Credits are still checked and consumed
 * for OpenAI and Imagen, because those are real spend. The caller handles the
 * fallback, serially, so the stock providers' per-run refusals stay meaningful.
 */
async function attemptGeneration(input: {
  directive: NeedImageDirective;
  projectId: string;
  userId?: string | null;
  skip: boolean;
  workerConfigured: boolean;
}): Promise<DirectiveOutcome> {
  const { directive } = input;
  if (input.skip) return { directive, reason: 'stock requested' };

  const paid = !input.workerConfigured;
  const denial = paid ? await paidGenerationDenial(input.userId) : null;
  if (denial) return { directive, reason: denial };

  try {
    const asset = await generateImage({
      projectId: input.projectId,
      userId: input.userId,
      prompt: directive.description,
      aspectRatio: directive.aspect,
    });
    // Metered only when a vendor was actually paid. The debit sits after the image
    // is counted as fulfilled: a concurrent request taking the last credit used to
    // throw the finished image away *and* skip the billing.
    if (asset.provider !== 'worker' && input.userId) {
      await consumeImageCredit(input.projectId, input.userId);
    }
    return { directive, url: asset.url };
  } catch (error) {
    return { directive, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** A stock photograph, or the same directive carrying why there is none. */
async function tryStock(
  input: {
    directive: NeedImageDirective;
    projectId: string;
    run: StockPhotoRun;
  },
  context: string,
): Promise<DirectiveOutcome> {
  try {
    const asset = await searchStockPhoto({
      projectId: input.projectId,
      query: input.directive.description,
      run: input.run,
    });
    return { directive: input.directive, url: asset.url };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { directive: input.directive, reason: `${context}: ${reason}` };
  }
}

/** Why a paid generation must not be attempted, or null when it may proceed. */
async function paidGenerationDenial(userId?: string | null): Promise<string | null> {
  if (!userId) return 'image generation needs a signed-in user';
  const credits = await checkCredits(WORKSPACE_ROW_ID, userId, 'image');
  return credits.ok ? null : `image credits denied (${credits.reason})`;
}

async function consumeImageCredit(projectId: string, userId: string) {
  try {
    await consumeCredits(WORKSPACE_ROW_ID, userId, 'image', projectId);
  } catch (error) {
    // `trackFailure` rather than a log line: this is provider spend nobody was
    // billed for, and it leaves no trace an operator can find otherwise —
    // `creditsUsed` and the CreditLedger under-count together, so /admin/usage
    // still balances and nothing looks wrong.
    trackFailure('credits.image_debit_failed', error, { action: 'image', projectId, userId });
  }
}

/** Runs `size` at a time, preserving input order in the results. */
async function inBatches<T, R>(
  items: T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(...(await Promise.all(items.slice(index, index + size).map(run))));
  }
  return out;
}

/**
 * A token nobody could fulfil becomes a neutral panel rather than the literal
 * string `NEED_IMAGE: …` sitting in a `src` attribute. Shipping the raw token
 * is what put broken images on a generated site.
 */
function withPlaceholdersForUnfulfilled(content: string): string {
  const leftovers = placeholderReplacements(content);
  const replaced = leftovers.length === 0 ? content : replaceNeedImageTokens(content, leftovers);
  // The parser is not the guarantee. A directive shaped in a way it misses used to
  // ship the literal token inside generated source; the sweep works on raw text.
  return sweepNeedImageTokens(replaced);
}
