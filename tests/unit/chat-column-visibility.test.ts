import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chatPaneClassName, previewPaneClassName } from '@/components/workspace/chat-layout';

const WORKSPACE = readFileSync('components/workspace/ProjectWorkspace.tsx', 'utf8');
const GENERATION = readFileSync('components/workspace/GenerationWorkspace.tsx', 'utf8');

describe('chat collapse hides the column at every breakpoint', () => {
  it('collapses to zero width at lg instead of locking a 380px column', () => {
    const collapsed = chatPaneClassName(true);
    expect(collapsed).toMatch(/w-0/);
    expect(collapsed).toMatch(/overflow-hidden/);
    expect(collapsed).toMatch(/opacity-0/);
    expect(collapsed).not.toMatch(/lg:w-\[380px\]/);
    expect(collapsed).not.toMatch(/lg:opacity-100/);
    expect(chatPaneClassName(false)).toMatch(/w-\[380px\]/);
    expect(chatPaneClassName(false)).toMatch(/max-lg:w-full/);
  });

  it('still hides the preview below lg when chat is the one pane', () => {
    expect(previewPaneClassName(false)).toMatch(/max-lg:hidden/);
    expect(previewPaneClassName(true)).not.toMatch(/max-lg:hidden/);
  });

  it('ProjectWorkspace uses the helper instead of a raw w-0 collapse', () => {
    expect(WORKSPACE).toMatch(/chatPaneClassName\(chatCollapsed\)/);
    expect(WORKSPACE).toMatch(/previewPaneClassName\(chatCollapsed\)/);
    expect(WORKSPACE).not.toMatch(/chatCollapsed\s*\n\s*\? 'w-0 overflow-hidden opacity-0'/);
  });
});

describe('project chat is rehydrated instead of wiped', () => {
  it('does not clear the thread on a files-map project switch without a hydrate', () => {
    const at = GENERATION.indexOf('if (previousId && previousId !== id)');
    expect(at).toBeGreaterThan(-1);
    const block = GENERATION.slice(
      at,
      GENERATION.indexOf('fileMapUnreadableRef.current = false', at),
    );
    expect(block).not.toMatch(/setChatMessages\(\[\]\)/);
    expect(block).toMatch(/hydrateChatForProject|readPersistedChat|hydrateChatMessages/);
  });
});
