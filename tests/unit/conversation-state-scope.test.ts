import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { conversationStateFor, resetConversationStates } from '@/lib/generation/conversation-state';
import type { ConversationMessage } from '@/types/conversation';

const ROUTE = fileURLToPath(
  new URL('../../app/api/generate-ai-code-stream/route.ts', import.meta.url),
);

function userMessage(content: string): ConversationMessage {
  return { id: `msg-${content}`, role: 'user', content, timestamp: Date.now() };
}

/**
 * Generation conversation context used to be one process global that each request reset.
 * Two overlapping runs for different projects then shared it: the later request wiped the
 * earlier one's history, and the earlier run's context build — which happens in a detached
 * worker, after several awaits — read the newer project's messages, pasting another user's
 * prompt into its model call. The project lock only serializes the same project.
 */
describe('conversation state is scoped per project', () => {
  afterEach(() => {
    resetConversationStates();
  });

  it('does not leak one project\u2019s messages into another\u2019s context', () => {
    const alpha = conversationStateFor('project-alpha', 'user-1');
    alpha.context.messages.push(userMessage('build a bakery site'));

    // Project B's request arrives while A is still streaming.
    const beta = conversationStateFor('project-beta', 'user-2');
    beta.context.messages.push(userMessage('add a payroll dashboard'));

    expect(alpha.context.messages.map((message) => message.content)).toEqual([
      'build a bakery site',
    ]);
    expect(beta.context.messages.map((message) => message.content)).toEqual([
      'add a payroll dashboard',
    ]);
    expect(alpha).not.toBe(beta);
  });

  it('leaves the first run\u2019s history intact for its own follow-up', () => {
    const first = conversationStateFor('project-alpha', 'user-1');
    first.context.messages.push(userMessage('build a bakery site'));
    first.context.edits.push({
      timestamp: Date.now(),
      userRequest: 'build a bakery site',
      editType: 'ADD_FEATURE',
      targetFiles: ['src/App.tsx'],
      confidence: 1,
      outcome: 'success',
    });

    conversationStateFor('project-beta', 'user-1');

    const followUp = conversationStateFor('project-alpha', 'user-1');
    expect(followUp).toBe(first);
    expect(followUp.context.messages).toHaveLength(1);
    expect(followUp.context.edits.flatMap((edit) => edit.targetFiles)).toEqual(['src/App.tsx']);
  });

  it('keeps two people\u2019s unsaved builds apart', () => {
    // A run with no project row is the one case with nothing to key on. Keying those on `''`
    // put every unsaved build in the process into one bucket, so two people starting from the
    // home page still shared messages, edits and the "DO NOT RECREATE THESE" file list — the
    // same cross-user bleed this module exists to stop, merely narrowed to the unsaved path.
    const mine = conversationStateFor(null, 'user-1');
    mine.context.messages.push(userMessage('a bakery in Oslo'));

    const theirs = conversationStateFor(null, 'user-2');
    expect(theirs).not.toBe(mine);
    expect(theirs.context.messages).toEqual([]);

    // The same person's next unsaved request still finds their own history.
    expect(conversationStateFor(null, 'user-1')).toBe(mine);
    expect(mine.projectId).toBeNull();
    expect(conversationStateFor('project-alpha', 'user-1').projectId).toBe('project-alpha');
  });

  it('evicts the least recently used project rather than growing forever', () => {
    const first = conversationStateFor('project-0', 'user-1');
    first.context.messages.push(userMessage('first'));
    for (let index = 1; index <= 25; index += 1) {
      conversationStateFor(`project-${index}`, 'user-1');
    }

    // project-0 was pushed out, so it comes back empty instead of holding stale context.
    expect(conversationStateFor('project-0', 'user-1').context.messages).toEqual([]);
    expect(conversationStateFor('project-25', 'user-1').context.messages).toEqual([]);
  });

  it('cannot lose a running generation\u2019s history to an eviction', () => {
    // A run resolves its state once and holds that reference for the whole stream, so being
    // evicted from the registry mid-generation costs the follow-up its history at worst — it
    // can never blank the context the running request is still writing into.
    const live = conversationStateFor('project-live', 'user-1');
    live.context.messages.push(userMessage('build it'));

    for (let index = 0; index <= 25; index += 1) {
      conversationStateFor(`project-${index}`, 'user-1');
    }
    live.context.messages.push(userMessage('and add a footer'));

    expect(live.context.messages.map((message) => message.content)).toEqual([
      'build it',
      'and add a footer',
    ]);
  });
});

/**
 * `conversationProjectId` is also what decides whether the route reads the project's stored
 * code. These assertions are on the route source because the branch is inline in a 1900-line
 * handler; they name the exact conditions, so flipping one back fails here.
 */
describe('the generate route trusts the project row, not the client', () => {
  it('loads the project\u2019s files whenever there is a project, not when the client says isEdit', () => {
    const source = readFileSync(ROUTE, 'utf8');
    const load = source.slice(
      source.indexOf('let backendFiles: Record<string, string> = {};'),
      source.indexOf('let hasBackendFiles ='),
    );
    // `isEdit` is a client hint. Reading the row only when the client claimed an edit let a
    // request that claimed `isEdit: false` skip the read, land in FIRST GENERATION MODE, and
    // have the model rewrite a project that already had stored code from scratch.
    expect(load).toMatch(/if \(conversationProjectId\) \{/);
    expect(load).not.toMatch(/isEdit/);
    expect(load).toMatch(/getCurrentProjectFiles\(projectFilesRow\)/);
  });

  it('reaches first-generation mode only when the project row held no files', () => {
    const source = readFileSync(ROUTE, 'utf8');
    const firstGen = source.indexOf('FIRST GENERATION MODE - CREATE SOMETHING BEAUTIFUL');
    expect(firstGen).toBeGreaterThan(-1);
    const guard = source.slice(source.lastIndexOf('} else if (', firstGen), firstGen);
    expect(guard).toMatch(/} else if \(!hasBackendFiles\) \{/);
  });

  it('builds prompt context whenever there is a project, even with no client context object', () => {
    const source = readFileSync(ROUTE, 'utf8');
    // Gating the whole block on `context` was a second way to skip the file load: omit the
    // object and the project's stored code was never read at all.
    expect(source).toMatch(/if \(context \|\| conversationProjectId\) \{/);
    expect(source).not.toMatch(/\n {8}if \(context\) \{\n {10}const contextParts/);
  });

  it('publishes a copy to the legacy global, never the live registry entry', () => {
    const source = readFileSync(ROUTE, 'utf8');
    const publish = source.slice(
      source.indexOf('global.conversationState = {'),
      source.indexOf('// Debug: Show a sample of actual file content'),
    );
    // /api/conversation-state's `clear-old` — POSTed on every workspace mount — reassigns
    // `context.messages`, `context.edits` and `context.projectEvolution.majorChanges`. Applied
    // to the live object, that truncated another project's history mid-run; every container it
    // reassigns through has to be a copy here.
    expect(publish).toMatch(/\.\.\.conversation,/);
    expect(publish).toMatch(/\.\.\.conversation\.context,/);
    expect(publish).toMatch(
      /projectEvolution: \{ \.\.\.conversation\.context\.projectEvolution \}/,
    );
    expect(publish).not.toMatch(/global\.conversationState = conversation;/);
  });
});
