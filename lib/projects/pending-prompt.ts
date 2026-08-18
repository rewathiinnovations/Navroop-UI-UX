/**
 * What to do with sessionStorage.navroopPrompt when a project workspace opens.
 *
 * The plan is the gate for a first build. A pending prompt must never start
 * generation while the project is PLANNING — Approve (or skip-planning) does that.
 */

export type PendingPromptAction =
  | { kind: 'none' }
  | { kind: 'show'; text: string }
  | { kind: 'send'; text: string };

export function decidePendingPromptAction(input: {
  phase?: string | null;
  prompt?: string | null;
}): PendingPromptAction {
  const text = input.prompt?.trim() ?? '';
  if (!text) return { kind: 'none' };
  // Shown as the user's opening message; never a silent second generate.
  if (input.phase === 'PLANNING') return { kind: 'show', text };
  // Deliberate skip-planning (URL import uses a different path).
  if (input.phase === 'BUILDING') return { kind: 'send', text };
  return { kind: 'show', text };
}

export function countFirstBuilds(input: {
  pendingPhase?: string | null;
  approved: boolean;
}): number {
  const pending = decidePendingPromptAction({
    phase: input.pendingPhase,
    prompt: 'pending',
  });
  return (pending.kind === 'send' ? 1 : 0) + (input.approved ? 1 : 0);
}
