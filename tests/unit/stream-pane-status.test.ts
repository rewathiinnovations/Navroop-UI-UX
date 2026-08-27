import { describe, expect, it } from 'vitest';
import { streamPaneStatus } from '@/components/workspace/StreamingCodePanel';

/**
 * The empty streaming pane's header. A photographed first build sat on the
 * job enum `generating` for the whole run — "Code appears here as each file
 * is written" under a label that never named a file or a phase — because the
 * preview path passed `GenerationState.status` instead of the progress line
 * the stream was already writing.
 */
describe('streamPaneStatus', () => {
  it('keeps the progress line the stream wrote', () => {
    expect(streamPaneStatus('Initializing AI...')).toBe('Initializing AI...');
    expect(streamPaneStatus('Generating app/page.tsx')).toBe('Generating app/page.tsx');
    expect(streamPaneStatus('Waiting for the model...')).toBe('Waiting for the model...');
    expect(streamPaneStatus('The model is thinking...')).toBe('The model is thinking...');
  });

  it('does not put the job enum in the pane header', () => {
    expect(streamPaneStatus('generating')).toBe('Writing files…');
    expect(streamPaneStatus('applying')).toBe('Writing files…');
    expect(streamPaneStatus('idle')).toBeNull();
    expect(streamPaneStatus('ready')).toBeNull();
  });
});
