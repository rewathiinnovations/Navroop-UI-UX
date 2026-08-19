import { decideSource } from '@/lib/assets/decide-source';
import { generateImage } from '@/lib/assets/generate-image';
import {
  parseNeedImageDirectives,
  placeholderReplacements,
  replaceNeedImageTokens,
  type NeedImageAspect,
} from '@/lib/assets/need-image';
import { searchStockPhoto } from '@/lib/assets/stock-photo';
import { checkCredits, consumeCredits } from '@/lib/plans/limits';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';

export type FulfillableFile = { path: string; content: string };

export async function fulfillNeedImages(input: {
  projectId: string;
  userId?: string | null;
  files: FulfillableFile[];
  sourceOverride?: 'stock' | 'generated';
}): Promise<FulfillableFile[]> {
  const combined = input.files.map((file) => file.content).join('\n');
  const directives = parseNeedImageDirectives(combined);
  if (directives.length === 0) return input.files;

  const replacements: Array<{ token: string; url: string }> = [];
  for (const directive of directives) {
    const source = input.sourceOverride ?? decideSource(directive.description);
    try {
      if (source !== 'stock') {
        if (!input.userId) continue;
        const credits = await checkCredits(WORKSPACE_ROW_ID, input.userId, 'image');
        if (!credits.ok) {
          console.warn('[assets] skip NEED_IMAGE, credits denied', credits.reason);
          continue;
        }
        const asset = await generateImage({
          projectId: input.projectId,
          userId: input.userId,
          prompt: directive.description,
          aspectRatio: directive.aspect as NeedImageAspect,
        });
        await consumeCredits(WORKSPACE_ROW_ID, input.userId, 'image', input.projectId);
        replacements.push({ token: directive.token, url: asset.url });
        continue;
      }
      const asset = await searchStockPhoto({
        projectId: input.projectId,
        query: directive.description,
      });
      replacements.push({ token: directive.token, url: asset.url });
    } catch (error) {
      // One image that cannot be sourced — no provider configured, a search
      // that matched nothing, a download that failed — must not cost the whole
      // site. The token falls through to the placeholder below.
      console.warn(
        '[assets] NEED_IMAGE unfulfilled:',
        directive.description,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return input.files.map((file) => ({
    path: file.path,
    content: withPlaceholdersForUnfulfilled(replaceNeedImageTokens(file.content, replacements)),
  }));
}

/**
 * A token nobody could fulfil becomes a neutral panel rather than the literal
 * string `NEED_IMAGE: …` sitting in a `src` attribute. Shipping the raw token
 * is what put broken images on a generated site.
 */
function withPlaceholdersForUnfulfilled(content: string): string {
  const leftovers = placeholderReplacements(content);
  if (leftovers.length === 0) return content;
  return replaceNeedImageTokens(content, leftovers);
}
