export type StackPromptEditContext = {
  editIntent: { type: string; confidence: number };
  primaryFiles: string[];
};

export type StackPromptContext = {
  conversationContext?: string;
  uiUxBrief?: string;
  isEdit?: boolean;
  editContext?: StackPromptEditContext | null;
  assetManifest?: string;
};

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
  if (ctx.isEdit) {
    const files = ctx.editContext?.primaryFiles?.length
      ? `Files to edit: ${ctx.editContext.primaryFiles.join(', ')}`
      : '';
    parts.push(
      `THIS IS AN EDIT. Change only the files required. Do not regenerate the app.${files ? `\n${files}` : ''}`,
    );
  }
  return parts.filter(Boolean).join('\n\n');
}
