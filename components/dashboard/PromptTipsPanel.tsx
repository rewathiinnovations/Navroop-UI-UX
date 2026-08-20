'use client';

import { useEffect, useState } from 'react';
import { notify } from '@/lib/notify';
import { saveOnboardingPreference } from '@/lib/onboarding/client';
import { PROMPT_TIPS } from '@/lib/onboarding/examples';

export default function PromptTipsPanel() {
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    void fetch('/api/onboarding')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        setHidden(Boolean(data?.promptTipsDismissedAt));
      })
      .catch(() => setHidden(true));
  }, []);

  if (hidden) return null;

  return (
    <aside className="mb-24 rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-16">
      <div className="flex items-start justify-between gap-12">
        <h2 className="text-[15px] font-medium text-[var(--studio-fg)]">{PROMPT_TIPS.title}</h2>
        <button
          type="button"
          className="rounded-8 px-6 py-2 text-[12px] text-[var(--studio-faint)] hover:text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
          onClick={async () => {
            // Hide optimistically, then put the panel back if the write lost —
            // silently hiding it made the panel reappear on the next load with
            // no explanation.
            setHidden(true);
            const result = await saveOnboardingPreference('dismiss-tips');
            if (!result.ok) {
              setHidden(false);
              notify.error(result.error);
            }
          }}
        >
          Dismiss
        </button>
      </div>
      <ol className="mt-12 space-y-10">
        {PROMPT_TIPS.rules.map((rule, index) => (
          <li key={rule.title} className="text-[13px] leading-5 text-[var(--studio-muted)]">
            <span className="font-medium text-[var(--studio-fg)]">
              {index + 1}. {rule.title}.
            </span>{' '}
            {rule.detail}
          </li>
        ))}
      </ol>
      <div className="mt-14 grid gap-10 sm:grid-cols-2">
        {PROMPT_TIPS.examples.map((example) => (
          <div key={example.label} className="rounded-10 bg-[var(--studio-bg)] p-12">
            <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--studio-faint)]">
              {example.label}
            </p>
            <p className="mt-6 text-[13px] leading-5 text-[var(--studio-fg)]">{example.text}</p>
          </div>
        ))}
      </div>
    </aside>
  );
}
