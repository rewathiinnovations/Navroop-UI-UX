import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Confirmation and modal-accessibility contracts for the member-facing surface
 * (F-406, F-407, F-422, F-435).
 *
 * Four separate regressions, one root cause: destructive UI was built ad hoc at
 * each call site instead of through the shared primitives.
 *
 * - F-406: project delete used a raw `confirm()` — the native dialog blocks the
 *   main thread, cannot be themed, and is suppressible per-origin, after which
 *   Delete fires on a single click. `admin-ui-conventions.test.ts` already
 *   banned `window.confirm`, but the offending call was the bare global, so the
 *   scan below matches both spellings.
 * - F-407: five modals were `role="dialog" aria-modal="true"` on a plain `<div>`
 *   behind a full-screen `<button aria-label="Cancel">`. None moved focus into
 *   the panel, contained Tab, hid the background from assistive tech, or
 *   restored focus on close; two had no Escape handler at all.
 * - F-422: Delete on a workspace skill and Remove on an API key fired on one
 *   click, destroying hand-written content and a credential with no undo.
 * - F-435: the signed-out landing page locked itself to `h-dvh` with
 *   `overflow-hidden` and gave `<main>` no inner scroll, so the submit button
 *   was unreachable once an on-screen keyboard halved `dvh`.
 *
 * There is no DOM testing library in this repo, so these are source-scan
 * assertions: they pin the structural invariant (which primitive is rendered,
 * which class is present) rather than observed behaviour. The behaviour itself
 * comes from Radix, which is exercised by its own suite.
 */
function repoFile(relative: string) {
  return readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');
}

/** Comments name these APIs to explain them; only declarations count. */
function codeOnly(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** Every `.ts`/`.tsx` under the two client-surface roots. */
const clientSurface = ['app', 'components'].flatMap((root) => walk(root));

describe('destructive actions are gated by the shared dialog (F-406, F-422)', () => {
  it('no app or component file calls the native confirm, under either spelling', () => {
    const offenders: string[] = [];
    for (const file of clientSurface) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      // Two patterns, because the F-406 call site was the bare global and the
      // pre-existing convention test only looked for the `window.` form. The
      // lookbehind keeps `onConfirm(` and `props.confirm(` out of the match.
      if (/\bwindow\s*\.\s*confirm\s*\(/.test(code) || /(?<![.\w$])confirm\s*\(/.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the project card deletes through ConfirmDialog, not a native prompt', () => {
    const card = codeOnly(repoFile('components/dashboard/ProjectCard.tsx'));
    expect(card).toMatch(
      /import\s*\{[^}]*\bConfirmDialog\b[^}]*\}\s*from\s*'@\/components\/admin\/ConfirmAction'/,
    );
    expect(card).toContain('<ConfirmDialog');
  });

  it('deleting a workspace skill goes through ConfirmAction', () => {
    const panel = codeOnly(repoFile('components/settings/SkillsPanel.tsx'));
    expect(panel).toMatch(/import\s+ConfirmAction\s+from\s*'@\/components\/admin\/ConfirmAction'/);
    expect(panel).toContain('<ConfirmAction');
    // The bare danger button was the whole defect: one click destroyed up to
    // 4000 characters of hand-written instructions. ConfirmAction owns the
    // trigger now, so no unguarded danger button may remain in this file.
    expect(panel).not.toMatch(/<StudioButton[^>]*variant="danger"/);
  });

  it('removing an API key goes through ConfirmAction, personal and team alike', () => {
    const page = codeOnly(repoFile('app/(app)/settings/api-keys/page.tsx'));
    expect(page).toMatch(/import\s+ConfirmAction\s+from\s*'@\/components\/admin\/ConfirmAction'/);
    // Two removable rows on this page — the personal key and the team default.
    // Both were single-click; both must be wrapped.
    expect(page.match(/<ConfirmAction/g) ?? []).toHaveLength(2);
    expect(page).not.toMatch(/<StudioButton[^>]*variant="danger"/);
  });

  it('the skills panel surfaces a rejected server action instead of dropping it', () => {
    const panel = repoFile('components/settings/SkillsPanel.tsx');
    const bodyOf = (handler: string) => {
      const start = panel.indexOf(`const ${handler} = async`);
      expect(start, `${handler} handler not found`).toBeGreaterThan(-1);
      return panel.slice(start, panel.indexOf('\n  };', start));
    };

    // `toggle` fires from a bare checkbox with no dialog to report into, so it
    // needs saveDraft's try/catch + notify shape. It had neither: a rejected
    // action was an unhandled promise with no UI at all.
    const toggle = bodyOf('toggle');
    expect(toggle, 'toggle must catch a rejected action').toContain('catch');
    expect(toggle, 'toggle must notify on failure').toContain('notify.error');

    // `remove` runs only from ConfirmAction, which catches, stays open and
    // prints the reason inside the dialog. Throwing is therefore the reporting
    // path; what must not come back is the silent `return` that swallowed the
    // failure and left the row on screen as if nothing happened.
    const remove = bodyOf('remove');
    expect(remove, 'remove must throw so the dialog can show the reason').toContain('throw');
    expect(remove, 'remove must not swallow a failed delete').not.toContain('notify.error');
  });
});

describe('modals render the Radix dialog primitive (F-407)', () => {
  const studioModal = repoFile('components/ui/StudioModal.tsx');

  it('the shared shell is built on @radix-ui/react-dialog', () => {
    expect(studioModal).toContain("from '@radix-ui/react-dialog'");
    // Content is what carries FocusScope (Tab containment), hideOthers
    // (background hidden from assistive tech) and DismissableLayer (Escape).
    expect(studioModal).toContain('DialogPrimitive.Content');
    expect(studioModal).toContain('DialogPrimitive.Overlay');
    // Radix only knows how to restore focus to its own Trigger, and these open
    // from dropdown items and toolbar buttons that are not one.
    expect(studioModal).toContain('onCloseAutoFocus');
    // A dialog with no accessible name is what two of these shipped as.
    expect(studioModal).toContain('DialogPrimitive.Title');
  });

  it('remembers the element to restore focus to, and only restores a live one', () => {
    // Verified by keyboard at /settings/skills on the running dev server:
    // focusing a row's Delete, pressing Enter, then Escape puts focus back on
    // that Delete button (`document.activeElement.id === 'probe-trigger'`).
    //
    // The capture must survive the panel opening. It is timing-sensitive — a
    // capture that ran after Radix moved focus would remember a button inside
    // the panel, which unmounts on close, and the guard below would then send
    // focus to <body>. The A/B on the running server confirmed the effect fires
    // before Radix's autofocus, so this ordering is the contract being pinned.
    expect(studioModal).toMatch(/useEffect\(\(\) => \{\s*if \(open\) restoreRef\.current =/);
    // Never focus a detached node: a card menu that unmounted took its item
    // with it, and Radix's own default is the better answer then.
    expect(studioModal).toContain('document.contains(target)');
  });

  it('each of the five ported modals renders a shared dialog, not a bespoke overlay', () => {
    const ported = [
      'components/admin/ConfirmAction.tsx',
      'app/(app)/admin/team/InviteMember.tsx',
      'app/(app)/admin/integrations/IntegrationsAdmin.tsx',
      'components/connectors/ConnectorsGitHubCard.tsx',
      'components/templates/SaveAsTemplateDialog.tsx',
      'components/templates/TemplateSheet.tsx',
    ];

    for (const relative of ported) {
      const code = codeOnly(repoFile(relative));
      expect(
        /from '@\/components\/ui\/StudioModal'/.test(code) ||
          /from '@\/components\/admin\/ConfirmAction'/.test(code),
        `${relative} must render StudioModal or ConfirmAction/ConfirmDialog`,
      ).toBe(true);

      // The hand-rolled shape, verbatim: an in-place dialog role and a
      // full-screen cancel button standing in for a real overlay.
      expect(code, `${relative} still declares a hand-rolled dialog`).not.toContain(
        'aria-modal="true"',
      );
      expect(code, `${relative} still uses a button as its backdrop`).not.toContain(
        'aria-label="Cancel"',
      );
    }
  });

  it('the two integrations dialogs reuse the type-to-confirm ConfirmDialog already owns', () => {
    const admin = codeOnly(repoFile('app/(app)/admin/integrations/IntegrationsAdmin.tsx'));
    expect(admin.match(/<ConfirmDialog/g) ?? []).toHaveLength(2);
    expect(admin).toContain('confirmPhrase');
  });
});

describe('the signed-out landing page can be scrolled (F-435)', () => {
  const landing = repoFile('components/app/home/HomeLanding.tsx');

  it('gives main an inner scroll inside the locked h-dvh shell', () => {
    const main = landing.match(/<main className="([^"]+)"/)?.[1];
    expect(main, '<main> not found').toBeTruthy();
    // `h-dvh` + `overflow-hidden` on the root is deliberate; what was missing
    // is the inner scroller, so the hero, chips and submit button were clipped
    // with no way to reach them.
    expect(main).toContain('overflow-y-auto');
    // Without min-h-0 a flex child refuses to shrink below its content and the
    // scroller never activates — the pair is the fix, not either half.
    expect(main).toContain('min-h-0');
    // justify-center on a scroll container clips the leading edge instead of
    // scrolling to it; the child centres with `my-auto`, which collapses to 0
    // as soon as the content overflows.
    expect(main).not.toMatch(/\bjustify-center\b/);
  });

  it('centres the hero with auto margins that collapse when content overflows', () => {
    expect(landing).toMatch(/className="my-auto w-full max-w-\[720px\]/);
  });
});
