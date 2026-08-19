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

const DEFAULT_DEVICE: StoredPreviewDevice = { key: 'desktop', rotated: false };

export function usePreviewDevice() {
  const [state, setState] = useState<StoredPreviewDevice>(DEFAULT_DEVICE);

  // Read the saved device after mount only, so the server-rendered (always
  // desktop) markup matches the client's first render. The device reaches the
  // DOM through PreviewPanel's inline frame width/height, the toolbar's
  // selected-button classes and the top bar's size label, so reading storage
  // in the useState initializer made React throw away the server HTML and
  // re-render the whole workspace — the same hydration mismatch 5ef2454 fixed
  // for the sidebar. A phone user sees one desktop frame before this lands.
  useEffect(() => {
    let stored = DEFAULT_DEVICE;
    try {
      stored = parseStoredPreviewDevice(window.localStorage.getItem(PREVIEW_DEVICE_STORAGE_KEY));
    } catch {
      /* private mode / disabled storage — stay on desktop */
    }
    if (stored.key !== DEFAULT_DEVICE.key || stored.rotated !== DEFAULT_DEVICE.rotated) {
      setState(stored);
    }
  }, []);

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
