'use client';

import { useEffect, useState } from 'react';

const STEPS = [
  {
    target: 'chat',
    title: 'Chat',
    body: 'Describe the site here. Plan first, then build. Follow-ups edit the current project.',
  },
  {
    target: 'preview',
    title: 'Preview',
    body: 'The live preview updates as generation finishes. Switch device sizes from the toolbar.',
  },
  {
    target: 'publish',
    title: 'Publish',
    body: 'When the three integrations are connected, publish a preview or live URL from here.',
  },
] as const;

type Box = { top: number; left: number; width: number; height: number };

export default function ProductTour() {
  const [step, setStep] = useState(0);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<Box | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/onboarding')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data && !data.productTourCompletedAt) setOpen(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const sync = () => {
      const el = document.querySelector(`[data-tour="${STEPS[step].target}"]`);
      if (!el) {
        setBox(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      setBox({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
    };
    sync();
    window.addEventListener('resize', sync);
    const timer = window.setInterval(sync, 400);
    return () => {
      window.removeEventListener('resize', sync);
      window.clearInterval(timer);
    };
  }, [open, step]);

  const finish = () => {
    setOpen(false);
    void fetch('/api/onboarding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'complete-tour' }),
    });
  };

  if (!open) return null;
  const current = STEPS[step];
  const tooltipTop = box ? Math.min(box.top + box.height + 12, window.innerHeight - 180) : 80;
  const tooltipLeft = box ? Math.min(Math.max(box.left, 16), window.innerWidth - 320) : 80;

  return (
    <div className="pointer-events-none fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-black/20" />
      {box && (
        <div
          className="absolute rounded-12 ring-2 ring-[var(--studio-accent)]"
          style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
        />
      )}
      <div
        className="pointer-events-auto absolute w-[300px] rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-14 shadow-lg"
        style={{ top: tooltipTop, left: tooltipLeft }}
        role="dialog"
        aria-label={current.title}
      >
        <p className="text-[13px] font-medium text-[var(--studio-fg)]">{current.title}</p>
        <p className="mt-6 text-[13px] leading-5 text-[var(--studio-muted)]">{current.body}</p>
        <div className="mt-12 flex items-center justify-between">
          <button type="button" className="text-[12px] text-[var(--studio-faint)]" onClick={finish}>
            Skip
          </button>
          <button
            type="button"
            className="inline-flex h-32 items-center rounded-full bg-[var(--studio-fg)] px-12 text-[12px] font-medium text-[var(--studio-bg)]"
            onClick={() => {
              if (step >= STEPS.length - 1) finish();
              else setStep((value) => value + 1);
            }}
          >
            {step >= STEPS.length - 1 ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
