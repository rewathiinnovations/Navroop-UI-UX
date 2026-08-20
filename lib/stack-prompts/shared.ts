export type StackPromptContext = {
  conversationContext?: string;
  uiUxBrief?: string;
  isEdit?: boolean;
  assetManifest?: string;
};

/**
 * Follow-up edit discipline. Recovered from `lib/context-selector.ts` and
 * `lib/edit-examples.ts`, which carried it behind an `if (manifest)` gate whose
 * global had no writer — so the model never received a word of it — and which
 * were deleted in bce41e5 (F-800/F-801). Until then the whole edit instruction
 * was the first line below.
 *
 * This is volatile, not part of the cacheable prefix: on a first build there is
 * nothing to preserve and "do not refactor" would fight the actual request.
 */
export const EDIT_RULES = `THIS IS AN EDIT. Change only the files required. Do not regenerate the app.
- Preserve the existing code. Make the minimal change asked for and nothing else.
- Do not refactor, reformat, rename, or "improve" anything you were not asked about.
- Do not remove existing code or change existing behaviour outside the request.
- Keep every import and export, and match the file's existing style.
- Emit the COMPLETE file for each file you change — a surgeon's incision, not a repaint.
- A style-only request changes only the property named. "Make the header blue" edits that one colour and leaves every other class untouched.

DO NOT CREATE A NEW FILE WITH A SIMILAR NAME TO ONE THAT EXISTS. Edit the existing file.
- Read the project files listed in this turn before deciding a file is missing.
- Nav and menu markup usually lives inside Header, not in its own file. A logo usually lives in Header too. Footer links live in Footer.
- Asked for "the nav": find the existing navigation first — only create Nav when no file contains it.
- Never end up with two files that render the same section.`;

export const COMPLETION_RULES = `OUTPUT FORMAT:
- Explain your work in one short paragraph, then emit the files.
- Every file goes in its own fenced block whose opening tag carries the path:
  \`\`\`tsx{path=src/App.tsx}
  // full file contents
  \`\`\`
- REQUIRED: every fence carries {path=...}. Never open a bare \`\`\`tsx fence.
- REQUIRED: the first line inside a fence is code, never a filename or comment
  repeating the path.
- Never list file names outside a fence.
- Full relative paths from the project root, stable across turns.
- Complete files only. Never truncate, ellipsis, or ask to continue.
- On a follow-up, emit only the files that change.
- Escape apostrophes; straight quotes only.
- Showing code as content? Put it in a template literal and escape backticks and \${ — never paste raw JSX/HTML into text.`;

export function buildVolatilePromptSuffix(ctx?: StackPromptContext | null): string {
  if (!ctx) return '';
  const parts: string[] = [];
  if (ctx.conversationContext?.trim()) parts.push(ctx.conversationContext.trim());
  if (ctx.uiUxBrief?.trim()) parts.push(ctx.uiUxBrief.trim());
  if (ctx.assetManifest?.trim()) parts.push(ctx.assetManifest.trim());
  if (ctx.isEdit) parts.push(EDIT_RULES);
  return parts.filter(Boolean).join('\n\n');
}
