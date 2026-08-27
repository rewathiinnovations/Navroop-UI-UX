'use client';

import StreamingCodePanel, { streamPaneStatus } from './StreamingCodePanel';
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
  // The thinking banner moved to the chat panel (`ChatPanel`), where the user is
  // waiting. The Code pane is all code: no file has landed yet, the panel's own
  // empty state says "Code appears here as each file is written".
  const totalComponents = progress.components.length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-12 overflow-hidden p-16">
      <div className="min-h-0 flex-1">
        {/* `activePath` is deliberately not passed: the trailing incomplete entry
            is the open file, and the panel's selector is the only thing allowed
            to work that out. A second opinion here would fight the reader's pick. */}
        <StreamingCodePanel
          files={progress.files}
          droppedPaths={progress.droppedPaths}
          status={streamPaneStatus(progress.status)}
          streamedText={progress.streamedCode}
          // The Code view outlives the build — the workspace keeps rendering it
          // while `files` is non-empty — and a finished build has no open file,
          // so the panel would sit on the last thing streamed (a Footer, on the
          // measured run). Only then may it choose the project's entry file.
          settled={!progress.isGenerating && progress.files.length > 0}
          className="h-full"
        />
      </div>

      {/* Named components announced by the stream's `component` events — a
          different count from the panel's "N files written", and the only place
          it is shown. */}
      {totalComponents > 0 ? (
        <div className="h-2 shrink-0 overflow-hidden rounded-full bg-[var(--studio-skeleton)]">
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
