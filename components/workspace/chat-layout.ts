/**
 * Chat / preview pane widths.
 *
 * Below `lg` the workspace is one pane: collapse hides chat and shows preview.
 * On `lg+` the chat column is 380px by default; Collapse chat still hides it
 * so the preview can fill the row.
 */
export function chatPaneClassName(collapsed: boolean): string {
  return collapsed
    ? 'w-0 overflow-hidden opacity-0'
    : 'w-[380px] max-lg:w-full opacity-100';
}

export function previewPaneClassName(chatCollapsed: boolean): string {
  return chatCollapsed
    ? 'flex min-h-0 min-w-0 flex-1 flex-col'
    : 'flex min-h-0 min-w-0 flex-1 flex-col max-lg:hidden';
}
