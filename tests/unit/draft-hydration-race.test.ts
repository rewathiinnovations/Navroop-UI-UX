import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { draftHydrationApplies } from '../../hooks/useDraftStorage';

/**
 * The prompt box must not empty itself.
 *
 * `useDraftStorage` restores the saved draft in a mount effect. The textarea is server
 * rendered, so it is on screen and focusable well before that effect runs — and the effect
 * used to assign `stored?.text ?? ""` unconditionally. Anything typed in that window was
 * overwritten with the empty string: the prompt vanished and the submit button, which is
 * disabled on an empty value, greyed back out. On a cold compile the window is seconds
 * wide, which is exactly when a first-time user is typing.
 *
 * The behavioural half is the decision function; the source half is here because the
 * behavioural half keeps passing if someone drops the guard at the call site.
 */

const HOOK = path.join(process.cwd(), 'hooks/useDraftStorage.ts');

describe('a draft hydration never overwrites what the reader already typed', () => {
  it('does not apply once the draft has been edited under the same key', () => {
    expect(draftHydrationApplies('navroop_pending_prompt', 'navroop_pending_prompt')).toBe(false);
  });

  it('applies on a first mount, when nothing has been edited yet', () => {
    expect(draftHydrationApplies(null, 'navroop_pending_prompt')).toBe(true);
  });

  it('still applies when the key changes, so switching projects loads that project’s draft', () => {
    // The workspace composer keys on the project id (`navroop_draft_${projectId}`), and that
    // key changes from the `pending` placeholder to the real id as the project resolves.
    // Holding a plain "dirty" boolean instead of the key would strand project B on
    // project A's text.
    expect(draftHydrationApplies('navroop_draft_proj_a', 'navroop_draft_proj_b')).toBe(true);
    expect(draftHydrationApplies('navroop_draft_pending', 'navroop_draft_proj_a')).toBe(true);
  });

  it('guards the hydration effect at the call site, and the setters mark the draft edited', () => {
    const source = readFileSync(HOOK, 'utf8');

    // The restore must sit behind the decision, not run unconditionally.
    expect(source).toMatch(/if \(draftHydrationApplies\(editedForKeyRef\.current, key\)\) \{/);

    // A bare `setValue(stored?.text ?? "")` outside that block is the regression.
    const guarded = source.slice(source.indexOf('draftHydrationApplies(editedForKeyRef.current'));
    expect(guarded).toMatch(/setValueState\(stored\?\.text \?\? ""\)/);

    // The ref only means anything if editing sets it, and it must record the key rather
    // than a boolean.
    expect(source).toMatch(/editedForKeyRef\.current = key/);
    for (const setter of [
      'setValue',
      'setStack',
      'setDesignDirection',
      'setImportMode',
      'setTemplateId',
    ]) {
      expect(source, `${setter} must mark the draft edited`).toMatch(
        new RegExp(`const ${setter} = useCallback[\\s\\S]{0,200}?markEdited\\(\\)`),
      );
    }
  });
});
