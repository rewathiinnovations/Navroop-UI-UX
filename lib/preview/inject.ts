import { INSPECTOR_SCRIPT, INSPECTOR_SCRIPT_ID } from '@/lib/visual-edits/inspector';

/** Inject the visual-edit inspector into built HTML at upload time — never into user source. */
export function injectInspectorIntoHtml(html: string) {
  if (html.includes(INSPECTOR_SCRIPT_ID)) return html;
  const tag = `<script id="${INSPECTOR_SCRIPT_ID}">${INSPECTOR_SCRIPT}</script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${tag}</body>`);
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, `${tag}</html>`);
  return `${html}\n${tag}`;
}
