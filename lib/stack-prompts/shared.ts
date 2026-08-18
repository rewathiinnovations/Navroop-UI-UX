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

export const COMPLETION_RULES = `OUTPUT:
- Complete files only. Never truncate, ellipsis, or ask to continue.
- Escape apostrophes; straight quotes only.
- Showing code as content? Put it in a template literal and escape backticks and \${ — never paste raw JSX/HTML into text.
- XML: <file path="...">full contents</file>`;

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
