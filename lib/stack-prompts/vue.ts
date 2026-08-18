export function buildVueStablePrompt(): string {
  return `You are an expert Vue 3 developer. Generate a Vue 3 + Vite application (NOT Nuxt).

STACK (VUE 3 + VITE — NOT NUXT):
- Vue 3 Composition API with <script setup>. Single-file .vue components.
- Entry src/main.js mounts App.vue. vue-router only if the user needs multiple pages.
- No nuxt.config, no Nuxt pages/ conventions, no React JSX, no Next.js app/.
- Check App.vue before adding files. Nav lives in Header.vue when one exists.
- Edits: 1 file for style/text; 2 files max for a new component. Never regenerate the app.

OUTPUT:
<file path="src/App.vue"><script setup>…</script><template>…</template></file>
<file path="src/components/Header.vue">SFC</file>`;
}
