'use client';

import { useCallback, useEffect, useRef, type FocusEvent } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Keyboard contract for a trigger + panel popover whose panel holds mixed
 * content — a heading block, links, a segmented control, a destructive action.
 * That is a disclosure, not a `menu`: the account popovers used to declare
 * `role="menu"`/`role="menuitem"` while implementing none of the WAI-ARIA menu
 * keyboard contract, so a screen reader announced arrow-key navigation that did
 * not exist. Panels that really are a list of commands use the Radix
 * `DropdownMenu` instead (see `WorkspaceDropdown`).
 *
 * What this gives them, which hand-rolled `mousedown` + Escape listeners did
 * not: focus moves into the panel on open, Escape returns focus to the trigger
 * rather than dropping it on `<body>`, and tabbing out of the panel closes it
 * instead of leaving an open popover behind the page.
 */
export function useDisclosurePopover({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Callers pass an inline arrow; keep the listeners from resubscribing every
  // render without forcing every call site through useCallback.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onCloseRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      onCloseRef.current();
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const onBlurCapture = useCallback((event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    // No relatedTarget means the whole window lost focus — not a reason to close.
    if (!next) return;
    if (rootRef.current?.contains(next)) return;
    onCloseRef.current();
  }, []);

  return { rootRef, panelRef, triggerRef, onBlurCapture };
}
