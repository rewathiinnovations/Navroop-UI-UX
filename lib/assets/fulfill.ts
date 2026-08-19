import { generateImage } from '@/lib/assets/generate-image';
import { imageWorkerConfig } from '@/lib/assets/image-worker';
import {
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
  // A copy, so attaching `unfulfilled` never mutates the caller's own array.
  if (directives.length === 0) return Object.assign([...input.files], { unfulfilled: [] });

  // Shared across directives so a provider that has refused for the whole
  // generation is skipped for the rest of it rather than asked again per image.
  const run: StockPhotoRun = {};
  const worker = input.sourceOverride === 'stock' ? null : await imageWorkerConfig();

  // Generation runs three at a time: the worker takes about twelve seconds per
  // image, so a six-image site would otherwise add over a minute to every build.
  const generated = await inBatches(directives, 3, (directive) =>
    attemptGeneration({
      directive,
      projectId: input.projectId,
      userId: input.userId,
      skip: input.sourceOverride === 'stock',
      workerConfigured: Boolean(worker),
    }),
  );

  const replacements: Array<{ token: string; url: string }> = [];
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
      replacements.push({ token: settled.directive.token, url: settled.url });
      continue;
    }
    console.warn('[assets] NEED_IMAGE unfulfilled:', settled.directive.description, settled.reason);
    unfulfilled.push({
      description: settled.directive.description,
      aspect: settled.directive.aspect,
      reason: settled.reason ?? 'no image provider answered',
    });
  }

  const files = input.files.map((file) => ({
    path: file.path,
    content: withPlaceholdersForUnfulfilled(replaceNeedImageTokens(file.content, replacements)),
  }));
  return Object.assign(files, { unfulfilled });
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
