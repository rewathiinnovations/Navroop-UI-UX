'use client';

import { EXAMPLE_PROMPTS } from '@/lib/onboarding/examples';

export default function ExamplePromptCards({
  onChoose,
}: {
  onChoose: (prompt: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-12 sm:grid-cols-3">
      {EXAMPLE_PROMPTS.map((example) => (
        <button
          key={example.id}
          type="button"
          onClick={() => onChoose(example.prompt)}
          className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-16 text-left transition-colors hover:bg-[var(--studio-surface-hover)]"
        >
          <p className="text-[14px] font-medium text-[var(--studio-fg)]">{example.title}</p>
          <p className="mt-6 text-[13px] leading-5 text-[var(--studio-muted)]">{example.summary}</p>
        </button>
      ))}
    </div>
  );
}
