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

/**
 * The output contract when the model writes through tools instead of fences.
 *
 * Deliberately short: there is no text format left to defend. The fenced
 * contract above spends eleven lines guarding a protocol against truncation,
 * bare fences and paths written as prose, because each of those was a real
 * silent failure — a reply that parses to zero files looks exactly like a reply
 * that answered a question. A tool call has none of those failure modes, so the
 * only rules left are where code may go and what to say around it.
 */
export const TOOL_OUTPUT_RULES = `OUTPUT FORMAT:
- Say in one or two sentences what you are about to do, then call the tools.
- Every file you create or change goes through write_file with the COMPLETE file contents.
- Never put code in your reply text. Code reaches the project only through a tool call.
- Never list file paths as prose. The tool call is the record.
- Read a file before editing it, and use edit_file for a small change to a large file.
- Use search_files to find a component or symbol instead of guessing a path.
- Building a section — hero, features, pricing, testimonials, FAQ, footer? Call use_section first.
  It validates your content against the real component and returns the imports and JSX to paste,
  so the prop names are right the first time. Hand-write a <section> only for something the
  catalogue cannot express.
- Need a package? Call add_dependency first. Never write an import for a package you have not added.
- After the tool calls, close with one or two sentences on what changed and where to look in the preview.`;

export function buildVolatilePromptSuffix(ctx?: StackPromptContext | null): string {
  if (!ctx) return '';
  const parts: string[] = [];
  if (ctx.conversationContext?.trim()) parts.push(ctx.conversationContext.trim());
  if (ctx.uiUxBrief?.trim()) parts.push(ctx.uiUxBrief.trim());
  if (ctx.assetManifest?.trim()) parts.push(ctx.assetManifest.trim());
  if (ctx.isEdit) parts.push(EDIT_RULES);
  return parts.filter(Boolean).join('\n\n');
}
