'use client';

import { useEffect } from 'react';

/**
 * Warns before the tab closes or hard-navigates while a form holds unsaved
 * edits. The browser shows its own generic dialog — the string we pass is
 * ignored by modern browsers but required for the prompt to appear.
 *
 * Client-side <Link> navigations are not intercepted here; App Router has no
 * stable public API for that. The close-tab / refresh case is where hand-typed
 * secrets actually get lost, and that case this covers.
 */
export function useUnsavedChangesWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chrome requires returnValue to be set for the dialog to show.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}
