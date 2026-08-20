'use client';

import { MessageSquare, MousePointer2, Pencil } from 'lucide-react';
import { cn } from '@/utils/cn';
import Hint from './Hint';
import type { VisualEditTool } from './types';

const TOOLS: Array<{ id: VisualEditTool; label: string; icon: typeof MousePointer2 | null }> = [
  { id: 'select', label: 'Select', icon: MousePointer2 },
  { id: 'text', label: 'Edit text', icon: null },
  { id: 'instruct', label: 'Describe a change', icon: Pencil },
  { id: 'comment', label: 'Comment', icon: MessageSquare },
];

export default function VisualEditsToolbar({
  activeTool,
  onChange,
}: {
  activeTool: VisualEditTool | null;
  onChange: (tool: VisualEditTool | null) => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Visual edits"
      className="absolute bottom-16 right-16 z-30 flex items-center gap-2 rounded-full border border-[var(--studio-line)] bg-[var(--studio-surface)] p-4 shadow-lg"
    >
      {TOOLS.map((tool) => {
        const Icon = tool.icon;
        const pressed = activeTool === tool.id;
        return (
          <Hint key={tool.id} label={tool.label}>
            <button
              type="button"
              aria-label={tool.label}
              aria-pressed={pressed}
              onClick={() => onChange(pressed ? null : tool.id)}
              className={cn(
                'studio-icon-hit inline-flex items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]',
                pressed
                  ? 'bg-[var(--studio-fg)] text-[var(--studio-bg)]'
                  : 'text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]',
              )}
            >
              {Icon ? <Icon className="size-15" /> : <span className="text-[13px] font-semibold leading-none">T</span>}
            </button>
          </Hint>
        );
      })}
    </div>
  );
}
