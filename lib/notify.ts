'use client';

/**
 * Central notification API, backed by react-toastify.
 *
 * Every user-facing success/error message in the app goes through this module
 * rather than calling `toast()` directly, so duplicate suppression, error
 * normalisation and the default options stay in one place.
 *
 * The rendering host is `components/ui/Toaster.tsx`, mounted once in
 * `AppProviders`.
 */

import { toast, type Id, type ToastOptions, type UpdateOptions } from 'react-toastify';
import { appConfig } from '@/config/app.config';

const DEFAULT_DURATION = appConfig.ui.toastDuration;

/** Errors stay on screen longer than successes — they carry more to read. */
const ERROR_DURATION = Math.max(DEFAULT_DURATION * 2, 6000);

type NotifyOptions = ToastOptions & {
  /**
   * Stable identity for the toast. Firing the same key again updates the
   * existing toast instead of stacking a duplicate — useful for handlers that
   * can run repeatedly (polling, retries, rapid clicks).
   */
  key?: string;
};

function resolve(options?: NotifyOptions): ToastOptions {
  if (!options) return {};
  const { key, ...rest } = options;
  return key ? { toastId: key, ...rest } : rest;
}

/**
 * Turns anything a `catch` block can receive into a human-readable line.
 * Handles Error, string and the API's `{ error }` / `{ message }` envelopes,
 * and falls back to a generic message rather than rendering "[object Object]".
 */
export function toMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (typeof error === 'string') return error.trim() || fallback;
  if (error instanceof Error) return error.message || fallback;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const field of ['error', 'message', 'detail', 'statusText'] as const) {
      const value = record[field];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return fallback;
}

export const notify = {
  success(message: string, options?: NotifyOptions): Id {
    return toast.success(message, { autoClose: DEFAULT_DURATION, ...resolve(options) });
  },

  error(error: unknown, options?: NotifyOptions & { fallback?: string }): Id {
    const { fallback, ...rest } = options ?? {};
    return toast.error(toMessage(error, fallback), {
      autoClose: ERROR_DURATION,
      ...resolve(rest),
    });
  },

  info(message: string, options?: NotifyOptions): Id {
    return toast.info(message, { autoClose: DEFAULT_DURATION, ...resolve(options) });
  },

  warning(message: string, options?: NotifyOptions): Id {
    return toast.warning(message, { autoClose: ERROR_DURATION, ...resolve(options) });
  },

  /** A spinner toast that never auto-closes. Resolve it with `notify.settle`. */
  loading(message: string, options?: NotifyOptions): Id {
    return toast.loading(message, resolve(options));
  },

  /**
   * Resolves a `notify.loading` toast in place, so a long action keeps one
   * toast from start to verdict rather than stacking a second one.
   */
  settle(
    id: Id,
    type: 'success' | 'error' | 'info' | 'warning',
    message: string,
    options?: UpdateOptions,
  ): void {
    toast.update(id, {
      render: message,
      type,
      isLoading: false,
      autoClose: type === 'error' ? ERROR_DURATION : DEFAULT_DURATION,
      // `null` restores the container's default close button, which the
      // loading state suppresses.
      closeButton: null,
      ...options,
    });
  },
};

/**
 * Calls `fetch`, throws a readable Error when the response is not ok (reading
 * the API's `{ error }` envelope), and returns the parsed JSON body. Pairs with
 * `notify.error` so a handler can be a plain try/catch.
 */
export async function fetchJson<T = unknown>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);

  let body: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    throw new Error(toMessage(body, `Request failed (${response.status})`));
  }

  return body as T;
}
