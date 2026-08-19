'use client';

import StreamingCodePanel from './StreamingCodePanel';
import type { GenerationProgressState } from '@/lib/generation/types';

/**
 * The Code view while a build runs. It is a separate component from
 * `GenerationWorkspace` for one reason: the workspace is ~2700 lines of client
 * state and cannot be rendered in the `react-dom/server` harness the streaming
 * tests use, so the view it shows was never asserted on. This piece is pure —
 * one prop, no hooks — so the harness can prove the in-progress file is on
 * screen.
 *
 * All of the file rail, highlighting, follow-along behaviour and the dropped-path
 * notice live in `StreamingCodePanel`; nothing here re-implements them. The
 * workspace used to draw its own rail and its own per-file code blocks, which is
 * why the file the model had *open* was invisible: only closed `</file>` fences
 * ever reached that markup.
 */
export default function GenerationCodeView({ progress }: { progress: GenerationProgressState }) {
  const showThinking = progress.isGenerating && (progress.isThinking || progress.thinkingText);
  const totalComponents = progress.components.length;

  return (
    <div className="absolute inset-0 flex flex-col gap-12 overflow-hidden p-16">
      {showThinking ? (
        <div className="shrink-0">
          <p className="mb-6 flex items-center gap-8 text-[13px] font-medium text-purple-600">
            {progress.isThinking ? (
              <>
                <span
                  aria-hidden
                  className="size-8 rounded-full bg-purple-600 motion-safe:animate-pulse"
                />
                AI is thinking...
              </>
            ) : (
              <>
                <span aria-hidden>✓</span>
                Thought for {progress.thinkingDuration ?? 0} seconds
              </>
            )}
          </p>
          {progress.thinkingText ? (
            <div className="max-h-48 overflow-y-auto rounded-12 border border-purple-700 bg-purple-950 p-12 scrollbar-hide">
              <pre className="font-mono text-[12px] whitespace-pre-wrap text-purple-300">
                {progress.thinkingText}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {/* `activePath` is deliberately not passed: the trailing incomplete entry
            is the open file, and the panel's selector is the only thing allowed
            to work that out. A second opinion here would fight the reader's pick. */}
        <StreamingCodePanel
          files={progress.files}
          droppedPaths={progress.droppedPaths}
          status={progress.status}
          streamedText={progress.streamedCode}
        />
      </div>

      {/* Named components announced by the stream's `component` events — a
          different count from the panel's "N files written", and the only place
          it is shown. */}
      {totalComponents > 0 ? (
        <div className="h-2 shrink-0 overflow-hidden rounded-full bg-gray-200">
          <div
            className="h-full bg-gradient-to-r from-orange-500 to-orange-400 transition-all duration-300"
            style={{
              width: `${(progress.currentComponent / Math.max(totalComponents, 1)) * 100}%`,
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
