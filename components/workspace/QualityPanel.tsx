'use client';

import { useState } from 'react';
import { cn } from '@/utils/cn';
import type { SendMessageOptions } from './types';
import SeoPanel from './SeoPanel';
import CodeAuditPanel from './CodeAuditPanel';

type QualityTab = 'seo' | 'code';

export default function QualityPanel({
  projectId,
  projectUpdatedAt,
  onSend,
  sending,
}: {
  projectId: string;
  projectUpdatedAt: string | null;
  onSend: (text: string, options: SendMessageOptions) => void;
  sending?: boolean;
}) {
  const [tab, setTab] = useState<QualityTab>('seo');

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--studio-bg)]">
      <div className="flex items-center gap-8 border-b border-[var(--studio-line)] px-16 py-10">
        {(
          [
            { id: 'seo', label: 'SEO & AI search' },
            { id: 'code', label: 'Code & performance' },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={cn(
              'inline-flex h-32 items-center rounded-full px-12 text-[12px] font-medium',
              tab === item.id
                ? 'bg-[var(--studio-fg)] text-[var(--studio-bg)]'
                : 'text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'seo' ? (
          <SeoPanel
            projectId={projectId}
            projectUpdatedAt={projectUpdatedAt}
            onSend={onSend}
            sending={sending}
          />
        ) : (
          <CodeAuditPanel
            projectId={projectId}
            projectUpdatedAt={projectUpdatedAt}
            onSend={onSend}
            sending={sending}
          />
        )}
      </div>
    </div>
  );
}
