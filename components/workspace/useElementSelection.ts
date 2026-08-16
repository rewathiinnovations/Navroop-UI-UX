'use client';

import { useCallback, useEffect, useState, type RefObject } from 'react';
import {
  isElementSelectedMessage,
  previewOriginFromUrl,
  type SelectedElementPayload,
  type SelectedElementRect,
} from '@/lib/visual-edits/inspector';

export type ElementSelection = {
  payload: SelectedElementPayload;
  pageRect: SelectedElementRect;
};

function translateRect(iframe: HTMLIFrameElement, rect: SelectedElementRect): SelectedElementRect {
  const frame = iframe.getBoundingClientRect();
  return {
    top: frame.top + rect.top,
    left: frame.left + rect.left,
    width: rect.width,
    height: rect.height,
  };
}

export function useElementSelection({
  iframeRef,
  sandboxUrl,
  enabled,
}: {
  iframeRef?: RefObject<HTMLIFrameElement | null>;
  sandboxUrl?: string | null;
  enabled: boolean;
}) {
  const [selection, setSelection] = useState<ElementSelection | null>(null);

  const clearSelection = useCallback(() => {
    setSelection(null);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setSelection(null);
      return;
    }

    const onMessage = (event: MessageEvent) => {
      const iframe = iframeRef?.current;
      if (!iframe?.contentWindow) return;
      if (event.source !== iframe.contentWindow) return;

      const expected =
        previewOriginFromUrl(iframe.src) ||
        previewOriginFromUrl(sandboxUrl);
      if (!expected || event.origin !== expected) return;
      if (!isElementSelectedMessage(event.data)) return;

      setSelection({
        payload: {
          ...event.data.payload,
          hasEditableText: Boolean(event.data.payload.hasEditableText),
        },
        pageRect: translateRect(iframe, event.data.payload.rect),
      });
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [enabled, iframeRef, sandboxUrl]);

  return { selection, clearSelection };
}
