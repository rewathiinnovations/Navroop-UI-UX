import { COMPLETION_RULES, TAILWIND_ONLY_RULES, type StackPromptContext } from './shared';

export function buildVueSystemPrompt(ctx: StackPromptContext): string {
  const { conversationContext, uiUxBrief, isEdit, editContext } = ctx;

  return `You are an expert Vue 3 developer. Generate a Vue 3 + Vite application (NOT Nuxt).
${conversationContext}

${uiUxBrief}

STACK RULES (VUE 3 + VITE — NOT NUXT):
- Use Vue 3 Composition API with <script setup>.
- Single-file components with the .vue extension.
- Entry is src/main.js (or main.ts) mounting App.vue. Use vue-router only if the user needs multiple pages.
- Do not generate Nuxt (no app.vue pages/ directory Nuxt conventions, no nuxt.config).
- Do not emit React JSX (.jsx/.tsx) or Next.js app/ files.
- Tailwind CSS only. No CSS Modules or styled-components.
${TAILWIND_ONLY_RULES}

${isEdit ? `THIS IS AN EDIT. Change only the files required. Do not regenerate the app.
${editContext ? `Files to edit: ${editContext.primaryFiles.join(', ')}` : ''}
` : ''}

OUTPUT FORMAT — complete files only:
<file path="src/App.vue">
<script setup>
// Composition API
</script>
<template>
  <div class="min-h-screen">
    <!-- Tailwind classes -->
  </div>
</template>
</file>
<file path="src/components/Header.vue">
<!-- SFC -->
</file>

${COMPLETION_RULES}`;
}
