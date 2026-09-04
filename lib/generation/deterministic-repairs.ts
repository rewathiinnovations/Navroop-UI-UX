import type { StackId } from '@/lib/stacks';
import {
  describeIconSubstitutions,
  fixLucideImports,
  type IconSubstitution,
} from './fix-icon-imports';
import { describeImageConversions, fixNextImages, type ImageConversion } from './fix-next-image';

/**
 * Corrections applied to generated code before it is stored, without a second
 * model call.
 *
 * Two classes qualify, and the bar for adding a third is the same: the defect
 * must be one the prompt already forbids and the model produces anyway, and the
 * correction must be mechanical enough that it cannot be wrong.
 *
 * - An icon `lucide-react` does not export. It compiles, the build check calls
 *   it clean, and the preview dies with "does not provide an export named
 *   'Implant'" as the first thing the user sees.
 * - A raw `<img>` on the Next.js stack, where the prompt has said `next/image`
 *   for a long time and the model still emitted six of them in one build.
 *
 * A repair turn would cost a generation, more latency, and another chance to
 * fail. These cost nothing and cannot regress: `lib/preview/assemble.ts` shims
 * `next/image` as a plain `<img>`, and the icon fix aliases the replacement to
 * the local name so no usage site moves.
 */

export type GenerationRepairs = {
  iconSubstitutions: IconSubstitution[];
  imageConversions: ImageConversion[];
};

export const NO_REPAIRS: GenerationRepairs = { iconSubstitutions: [], imageConversions: [] };

export function repairGeneratedFiles(
  files: Record<string, string>,
  stack: StackId,
): { files: Record<string, string>; repairs: GenerationRepairs } {
  const icons = fixLucideImports(files);
  // Only where `next/image` exists. On REACT and STATIC_HTML a raw `<img>` is
  // the correct element, and converting it would import a module that is not
  // there.
  const images =
    stack === 'NEXTJS' ? fixNextImages(icons.files) : { files: icons.files, conversions: [] };

  return {
    files: images.files,
    repairs: { iconSubstitutions: icons.substitutions, imageConversions: images.conversions },
  };
}

/** Whether anything changed, without having to inspect both lists. */
export function hasRepairs(repairs: GenerationRepairs): boolean {
  return repairs.iconSubstitutions.length > 0 || repairs.imageConversions.length > 0;
}

/** The paths this rewrote, so the caller can update only those. */
export function repairedPaths(repairs: GenerationRepairs): Set<string> {
  return new Set([
    ...repairs.iconSubstitutions.map((swap) => swap.file),
    ...repairs.imageConversions.map((conversion) => conversion.file),
  ]);
}

/**
 * Chat lines for what was changed. Silence would be worse than the original
 * defects: the page renders either way, so nobody would investigate, and the
 * icon beside "Dental implants" would be whatever the fallback chose.
 */
export function describeRepairs(repairs: GenerationRepairs): string[] {
  return [
    describeIconSubstitutions(repairs.iconSubstitutions),
    describeImageConversions(repairs.imageConversions),
  ].filter((line): line is string => line !== null);
}
