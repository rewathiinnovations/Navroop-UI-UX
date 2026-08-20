'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/utils/cn';

/**
 * The one modal shell for studio-styled dialogs and side sheets.
 *
 * Five modals used to be hand-rolled: `role="dialog" aria-modal="true"` on a
 * plain `<div>` behind a full-screen `<button aria-label="Cancel">`. None of
 * them moved focus into the panel, contained Tab inside it, hid the page behind
 * it from assistive tech, or put focus back where it came from — so a keyboard
 * user tabbed through the controls of a page they could not see and landed at
 * the top of the document on close. Two had no Escape handler at all.
 *
 * Radix's Dialog does all of that: `FocusScope` traps Tab and loops it,
 * `hideOthers()` marks everything outside the panel `aria-hidden`,
 * `DismissableLayer` handles Escape and outside pointer-downs, and
 * `react-remove-scroll` locks the background. `Dialog.Title` supplies
 * `aria-labelledby`, which two of these dialogs never had.
 *
 * Three deliberate departures from the vendored `components/ui/shadcn/dialog.tsx`
 * (which `AuthModal` uses and which stays as it is):
 *
 * 1. No portal. The studio palette lives on `.studio-shell`, so a panel
 *    portaled into `document.body` loses every `var(--studio-*)`. Rendering in
 *    place keeps the palette and matches where these panels already rendered.
 * 2. Focus is restored to whatever was focused when the modal opened, not to a
 *    `Dialog.Trigger`. Radix only knows how to focus its own trigger, and these
 *    open from dropdown items and toolbar buttons that are not one.
 * 3. `aria-modal="true"` is set explicitly. Radix relies on `hideOthers()`
 *    alone; keeping the attribute preserves what the hand-rolled markup already
 *    promised, and the two mechanisms reinforce each other.
 */
export default function StudioModal({
  open,
  onOpenChange,
  title,
  hideTitle = false,
  titleClassName,
  description,
  descriptionClassName,
  dismissible = true,
  placement = 'center',
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Rendered as the first child of the panel and wires `aria-labelledby`. Omit
   * it when the design needs the heading somewhere else in the layout — the
   * template sheet puts an eyebrow above it and a Close button beside it — and
   * render `<StudioModalTitle>` inside `children` instead. One of the two is
   * required: an unnamed dialog is what two of these shipped as.
   */
  title?: ReactNode;
  /** Keep the name for assistive tech when the design has no visible heading. */
  hideTitle?: boolean;
  titleClassName?: string;
  description?: ReactNode;
  descriptionClassName?: string;
  /** `false` while a mutation is in flight: Escape and outside clicks refused. */
  dismissible?: boolean;
  /** `top` is the command-palette position: near the top edge, not centred. */
  placement?: 'center' | 'right' | 'top';
  /** Classes for the panel itself. */
  className?: string;
  children: ReactNode;
}) {
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) restoreRef.current = document.activeElement as HTMLElement | null;
  }, [open]);

  const refuseWhenBusy = (event: { preventDefault: () => void }) => {
    if (!dismissible) event.preventDefault();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {/* Radix's Overlay and Content carry their own Presence, but this
          centering box does not — left mounted it would be a full-viewport
          `fixed` layer sitting over the closed page. */}
      {open ? (
        <>
          <DialogPrimitive.Overlay className="studio-fade-in fixed inset-0 z-50 bg-[var(--studio-fg)]/20" />
          <div
            className={cn(
              'fixed inset-0 z-50 flex',
              placement === 'right' && 'justify-end',
              placement === 'top' && 'items-start justify-center px-16 pt-[12vh]',
              placement === 'center' && 'items-center justify-center p-20',
            )}
          >
            <DialogPrimitive.Content
              aria-modal="true"
              onEscapeKeyDown={refuseWhenBusy}
              onPointerDownOutside={refuseWhenBusy}
              onInteractOutside={refuseWhenBusy}
              onCloseAutoFocus={(event) => {
                // Only claim the restore while the remembered element is still in
                // the document: a card menu that unmounted took its own item with
                // it, and Radix's own default is the better answer then.
                const target = restoreRef.current;
                if (target && document.contains(target)) {
                  event.preventDefault();
                  target.focus();
                }
              }}
              className={className}
            >
              {title === undefined ? null : (
                <DialogPrimitive.Title className={hideTitle ? 'sr-only' : titleClassName}>
                  {title}
                </DialogPrimitive.Title>
              )}
              {description ? (
                <DialogPrimitive.Description className={descriptionClassName}>
                  {description}
                </DialogPrimitive.Description>
              ) : null}
              {children}
            </DialogPrimitive.Content>
          </div>
        </>
      ) : null}
    </DialogPrimitive.Root>
  );
}

/**
 * The panel heading, for layouts that cannot have it as the panel's first child.
 * Works anywhere inside a `StudioModal` — it reads the generated id from Radix's
 * context, so `aria-labelledby` is wired either way.
 */
export const StudioModalTitle = DialogPrimitive.Title;
