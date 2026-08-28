import { WAITING_FOR_MODEL_STATUS } from './stream-parts';

export const STARTING_EDIT_STATUS = 'Starting AI generation...';
export const STARTING_EDIT_THINKING = 'Analyzing your request...';

/**
 * The Code pane's pre-stream line. Edit-mode copy ("Analyzing your request...")
 * is only honest when this project already has files to change. A first build
 * — including one the workspace wrongly tagged isEdit because leftover
 * appliedCode or a previous project's stream leaked across /project/[id] —
 * must show the wait, not a thinking banner that SSE has not confirmed.
 * `isThinking` stays false until a `thinking` frame arrives — starting it
 * true drew ChatPanel's reasoning card for every first build, including
 * when Admin → Configuration has `ai.deepseek.thinking` disabled.
 */
export function startingGenerationFields(input: { isEdit: boolean; hasCompletedFiles: boolean }): {
  status: string;
  isStreaming: boolean;
  isThinking: boolean;
  thinkingText: string | undefined;
} {
  if (input.isEdit && input.hasCompletedFiles) {
    return {
      status: STARTING_EDIT_STATUS,
      isStreaming: false,
      // Same as first build: the reasoning card waits for a real `thinking` SSE
      // frame. Starting true stuck the card when admin thinking was off, because
      // `thinking_complete` never arrived and a `status` frame did not clear it.
      isThinking: false,
      thinkingText: STARTING_EDIT_THINKING,
    };
  }
  return {
    status: WAITING_FOR_MODEL_STATUS,
    isStreaming: true,
    isThinking: false,
    thinkingText: undefined,
  };
}
