import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startingGenerationFields } from '@/lib/generation/starting-progress';
import { WAITING_FOR_MODEL_STATUS } from '@/lib/generation/stream-parts';

const ROUTE = fileURLToPath(
  new URL('../../app/api/generate-ai-code-stream/route.ts', import.meta.url),
);
const WORKSPACE = fileURLToPath(
  new URL('../../components/workspace/GenerationWorkspace.tsx', import.meta.url),
);
const RUNTIME = fileURLToPath(
  new URL('../../lib/generation/generation-runtime.ts', import.meta.url),
);

/**
 * A photographed first build sat on the client's pre-stream copy
 * ("Starting AI generation..." / "Analyzing your request...") for the whole
 * wait, because sendChatMessage always wrote the edit-mode banner and the
 * generate route did not return SSE until after the provider queue. A new
 * project opened while another DeepSeek run still held the slot never saw a
 * status frame, so the pane never left that local state.
 */
describe('startingGenerationFields', () => {
  it('does not use edit-mode copy on a first build with no files', () => {
    const fields = startingGenerationFields({ isEdit: false, hasCompletedFiles: false });
    expect(fields.status).toBe(WAITING_FOR_MODEL_STATUS);
    expect(fields.thinkingText).toBeUndefined();
    // Local isThinking would render ChatPanel's "AI is thinking..." card before
    // any SSE reasoning frame — and it would stay up for the whole run when
    // admin thinking is off, because thinking_complete never fires.
    expect(fields.isThinking).toBe(false);
    expect(fields.status).not.toMatch(/Starting AI generation/);
    expect(fields.thinkingText).not.toBe('Analyzing your request...');
  });

  it('still uses wait copy when isEdit is wrongly true but there are no files', () => {
    // Leftover appliedCode / a previous project's in-flight generate used to
    // mark a brand-new Approve as an edit and freeze the thinking banner.
    const fields = startingGenerationFields({ isEdit: true, hasCompletedFiles: false });
    expect(fields.status).toBe(WAITING_FOR_MODEL_STATUS);
    expect(fields.thinkingText).toBeUndefined();
    expect(fields.isThinking).toBe(false);
  });

  it('keeps edit copy only when this project already has files', () => {
    const fields = startingGenerationFields({ isEdit: true, hasCompletedFiles: true });
    expect(fields.status).toBe('Starting AI generation...');
    expect(fields.thinkingText).toBe('Analyzing your request...');
  });
});

describe('the first SSE status beats the provider queue', () => {
  it('sends Waiting for the model before awaiting a provider slot', () => {
    const source = readFileSync(ROUTE, 'utf8');
    const wait = source.indexOf('WAITING_FOR_MODEL_STATUS');
    const started = source.indexOf('providerSlot.started');
    expect(wait).toBeGreaterThan(-1);
    expect(started).toBeGreaterThan(-1);
    expect(started).toBeGreaterThan(wait);
  });
});

describe('the client starting state is the wait helper, not hardcoded edit copy', () => {
  it('send and stream both call startingGenerationFields', () => {
    const workspace = readFileSync(WORKSPACE, 'utf8');
    const runtime = readFileSync(RUNTIME, 'utf8');
    expect(workspace).toContain('startingGenerationFields');
    expect(runtime).toContain('startingGenerationFields');
    expect(workspace).not.toContain("thinkingText: 'Analyzing your request...'");
    expect(runtime).not.toContain("thinkingText: input.isEdit ? 'Analyzing your request...'");
  });
});
