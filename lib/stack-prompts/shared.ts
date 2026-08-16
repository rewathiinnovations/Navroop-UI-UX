export type StackPromptEditContext = {
  editIntent: { type: string; confidence: number };
  primaryFiles: string[];
};

export type StackPromptContext = {
  conversationContext: string;
  uiUxBrief: string;
  isEdit: boolean;
  editContext?: StackPromptEditContext | null;
};

export const TAILWIND_ONLY_RULES = `
CRITICAL STYLING RULES - MUST FOLLOW:
- ALWAYS use Tailwind CSS classes for ALL styling
- NEVER use CSS Modules, styled-components, Emotion, <style jsx>, or component-specific CSS files
- NEVER use inline style={{ }} objects for layout/visual styling
- NEVER use non-standard Tailwind classes like "border-border", "bg-background", "text-foreground"
- Use standard Tailwind classes only (bg-white, text-gray-900, bg-blue-600, etc.)
- ALWAYS ensure responsive design using sm:, md:, lg:, xl:
- NEVER use emojis in any code, text, console logs, or UI elements
`;

export const COMPLETION_RULES = `
CRITICAL COMPLETION RULES:
1. NEVER say "I'll continue with the remaining components"
2. NEVER say "Would you like me to proceed?"
3. NEVER use <continue> tags
4. Generate ALL files in ONE response
5. ALWAYS CREATE ALL FILES IN FULL - never provide partial implementations
6. ALWAYS IMPLEMENT COMPLETE FUNCTIONALITY - don't leave TODOs unless explicitly asked
`;
