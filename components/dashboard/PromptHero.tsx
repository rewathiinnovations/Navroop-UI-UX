'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import PromptBox from '@/components/app/studio/PromptBox';
import CategoryChips from '@/components/templates/CategoryChips';
import { PENDING_PROMPT_KEY, useDraftStorage } from '@/hooks/useDraftStorage';
import { DEFAULT_IMPORT_MODE, type ImportMode } from '@/lib/import/mode';
import { looksLikeUrl } from '@/lib/projects/prompt';
import { STACK_IDS, getStack, isStackId, type StackId } from '@/lib/stacks';

export type PromptHeroHandle = {
  flush: (next?: string) => void;
  focus: () => void;
  fill: (text: string) => void;
};

type PromptHeroProps = {
  greeting: string;
  /**
   * `designDirection` is deliberately absent. The hero used to carry a Design
   * direction select that defaulted to `minimal` and that almost nobody touched,
   * so every project claimed "minimal" while its prompt described a luxury
   * clinic or a data console — and the UI/UX brief, scoring the same prompt,
   * disagreed. The direction is now read from the prompt server-side
   * (`lib/design/infer-direction.ts`), which is the only way one design system
   * reaches the model.
   */
  onSubmit: (text: string, stack: StackId, importMode: ImportMode) => void | Promise<void>;
  description?: ReactNode;
};

const selectClassName =
  'h-[36px] max-w-[240px] cursor-pointer rounded-10 border border-[var(--studio-line-strong)] bg-transparent px-10 text-[13px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]';

const PromptHero = forwardRef<PromptHeroHandle, PromptHeroProps>(function PromptHero(
  { greeting, onSubmit, description },
  ref,
) {
  const { value, setValue, stack, setStack, importMode, setImportMode, flush } =
    useDraftStorage(PENDING_PROMPT_KEY);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [submitting, setSubmitting] = useState(false);

  // The dependency list is explicit so `fill`'s four inputs are stated rather than implied
  // by the closure, and so the handle keeps its identity between renders — without it the
  // object was rebuilt on every render, which defeats memoisation in any consumer that keys
  // off the ref (F-449). Functionally identical either way: the closures always saw current
  // values, and they still do, because every value they read is listed.
  useImperativeHandle(
    ref,
    () => ({
      flush,
      focus: () => textareaRef.current?.focus(),
      fill: (text: string) => {
        setValue(text);
        // `undefined` keeps the hook's stored direction: the draft record still
        // has the field, nothing in the hero sets it any more.
        flush(text, stack, undefined, importMode);
        window.setTimeout(() => textareaRef.current?.focus(), 20);
      },
    }),
    [flush, setValue, stack, importMode],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('focus') === 'prompt' || window.location.hash === '#prompt') {
      textareaRef.current?.focus();
    }
  }, []);

  const handleSubmit = async (text: string) => {
    flush(text, stack, undefined, importMode);
    setSubmitting(true);
    try {
      await onSubmit(text, stack, importMode);
    } finally {
      setSubmitting(false);
    }
  };

  const showImportMode = looksLikeUrl(value);

  return (
    <div className="w-full">
      <h1 className="text-center text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)] sm:text-[40px]">
        {greeting}
      </h1>
      {description}
      <div className="mt-28">
        <PromptBox
          textareaRef={textareaRef}
          value={value}
          onChange={setValue}
          onSubmit={(text) => void handleSubmit(text)}
          submitting={submitting}
          footerLeft={
            <div className="flex flex-wrap items-center gap-8">
              <label className="inline-flex min-h-[36px] items-center gap-8">
                <span className="sr-only">Stack</span>
                <select
                  value={stack}
                  aria-label="Stack"
                  onChange={(event) => {
                    const next = event.target.value;
                    if (isStackId(next)) setStack(next);
                  }}
                  className={selectClassName}
                >
                  {STACK_IDS.map((id) => {
                    const definition = getStack(id);
                    return (
                      <option key={id} value={id}>
                        {definition.seoHint
                          ? `${definition.label} · ${definition.seoHint}`
                          : definition.label}
                      </option>
                    );
                  })}
                </select>
              </label>
              {showImportMode && (
                <div
                  role="group"
                  aria-label="URL import mode"
                  className="inline-flex min-h-[44px] items-center rounded-10 border border-[var(--studio-line-strong)] p-2"
                >
                  {(
                    [
                      ['reimagine', 'Reimagine design'],
                      ['replicate', 'Replicate design'],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={(importMode ?? DEFAULT_IMPORT_MODE) === id}
                      onClick={() => setImportMode(id)}
                      className={
                        (importMode ?? DEFAULT_IMPORT_MODE) === id
                          ? 'min-h-[36px] rounded-8 bg-[var(--studio-surface)] px-10 text-[12px] font-medium text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]'
                          : 'min-h-[36px] rounded-8 px-10 text-[12px] text-[var(--studio-muted)] hover:text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]'
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {showImportMode && (
                <span className="text-[12px] text-[var(--studio-muted)]">Import (5 credits)</span>
              )}
            </div>
          }
        />
      </div>
      <div className="mt-16 flex flex-col items-center gap-10">
        <CategoryChips />
        <a
          href="/templates"
          className="text-[13px] font-medium text-[var(--studio-accent)] hover:underline"
        >
          Browse templates
        </a>
      </div>
    </div>
  );
});

PromptHero.displayName = 'PromptHero';

export default PromptHero;
