'use client';

import { useCallback, useEffect, useState, type RefObject } from 'react';
import { isMessageFromPreviewFrame } from '@/lib/preview/display';
import {
  isElementSelectedMessage,
  type SelectedElementPayload,
  type SelectedElementRect,
} from '@/lib/visual-edits/inspector';

export type ElementSelection = {
  payload: SelectedElementPayload;
  pageRect: SelectedElementRect;
};

function translateRect(iframe: HTMLIFrameElement, rect: SelectedElementRect): SelectedElementRect {
  const frame = iframe.getBoundingClientRect();
  const layoutWidth = iframe.offsetWidth || frame.width;
  const scale = layoutWidth ? frame.width / layoutWidth : 1;
  return {
    top: frame.top + rect.top * scale,
    left: frame.left + rect.left * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

export function useElementSelection({
  iframeRef,
  enabled,
}: {
  iframeRef?: RefObject<HTMLIFrameElement | null>;
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
      // Window identity, not origin. The preview frame is a `srcdoc` sandboxed
      // without allow-same-origin, so `event.origin` is the opaque string
      // "null" and `iframe.src` is empty — the old check compared that against
      // an origin parsed out of the served build's URL and dropped every
      // message the inspector sent (F-143).
      if (!iframe || !isMessageFromPreviewFrame(event, iframe)) return;
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
  }, [enabled, iframeRef]);

  return { selection, clearSelection };
}
