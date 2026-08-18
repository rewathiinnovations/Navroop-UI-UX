'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  PREVIEW_DEVICE_EVENT,
  PREVIEW_DEVICE_STORAGE_KEY,
  parseStoredPreviewDevice,
  serializePreviewDevice,
  type PreviewDeviceKey,
  type StoredPreviewDevice,
} from '@/lib/preview/devices';

function readStored(): StoredPreviewDevice {
  if (typeof window === 'undefined') return { key: 'desktop', rotated: false };
  try {
    return parseStoredPreviewDevice(window.localStorage.getItem(PREVIEW_DEVICE_STORAGE_KEY));
  } catch {
    return { key: 'desktop', rotated: false };
  }
}

export function usePreviewDevice() {
  const [state, setState] = useState<StoredPreviewDevice>(readStored);

  const persist = useCallback((next: StoredPreviewDevice) => {
    const normalized: StoredPreviewDevice = {
      key: next.key,
      rotated: next.key === 'desktop' ? false : next.rotated,
    };
    setState(normalized);
    try {
      window.localStorage.setItem(PREVIEW_DEVICE_STORAGE_KEY, serializePreviewDevice(normalized));
    } catch {
      /* private mode / quota */
    }
  }, []);

  useEffect(() => {
    const onEvent = (event: Event) => {
      const key = (event as CustomEvent<{ key?: PreviewDeviceKey }>).detail?.key;
      if (!key) return;
      persist({ key, rotated: false });
    };
    window.addEventListener(PREVIEW_DEVICE_EVENT, onEvent);
    return () => window.removeEventListener(PREVIEW_DEVICE_EVENT, onEvent);
  }, [persist]);

  const setDevice = useCallback(
    (key: PreviewDeviceKey) => {
      persist({ key, rotated: false });
    },
    [persist],
  );

  const toggleRotate = useCallback(() => {
    if (state.key === 'desktop') return;
    persist({ key: state.key, rotated: !state.rotated });
  }, [persist, state.key, state.rotated]);

  return {
    device: state.key,
    rotated: state.rotated,
    setDevice,
    toggleRotate,
  };
}
