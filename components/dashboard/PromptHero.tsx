"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import PromptBox from "@/components/app/studio/PromptBox";
import { PENDING_PROMPT_KEY, useDraftStorage } from "@/hooks/useDraftStorage";
import { STACK_IDS, getStack, isStackId, type StackId } from "@/lib/stacks";

export type PromptHeroHandle = {
  flush: (next?: string) => void;
  focus: () => void;
};

type PromptHeroProps = {
  greeting: string;
  onSubmit: (text: string, stack: StackId) => void | Promise<void>;
  description?: ReactNode;
};

const PromptHero = forwardRef<PromptHeroHandle, PromptHeroProps>(
  function PromptHero({ greeting, onSubmit, description }, ref) {
    const { value, setValue, stack, setStack, flush } = useDraftStorage(PENDING_PROMPT_KEY);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [submitting, setSubmitting] = useState(false);

    useImperativeHandle(ref, () => ({
      flush,
      focus: () => textareaRef.current?.focus(),
    }));

    useEffect(() => {
      const params = new URLSearchParams(window.location.search);
      if (params.get("focus") === "prompt" || window.location.hash === "#prompt") {
        textareaRef.current?.focus();
      }
    }, []);

    const handleSubmit = async (text: string) => {
      flush(text, stack);
      setSubmitting(true);
      try {
        await onSubmit(text, stack);
      } finally {
        setSubmitting(false);
      }
    };

    return (
      <div className="w-full">
        <h1 className="text-center text-[36px] font-medium tracking-[-0.03em] text-[var(--studio-fg)] sm:text-[42px]">
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
              <label className="inline-flex min-h-[36px] items-center gap-8">
                <span className="sr-only">Stack</span>
                <select
                  value={stack}
                  aria-label="Stack"
                  onChange={(event) => {
                    const next = event.target.value;
                    if (isStackId(next)) setStack(next);
                  }}
                  className="h-[36px] max-w-[220px] cursor-pointer rounded-10 border border-[var(--studio-line-strong)] bg-transparent px-10 text-[13px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
                >
                  {STACK_IDS.map((id) => (
                    <option key={id} value={id}>
                      {getStack(id).label}
                    </option>
                  ))}
                </select>
              </label>
            }
          />
        </div>
      </div>
    );
  },
);

PromptHero.displayName = "PromptHero";

export default PromptHero;
