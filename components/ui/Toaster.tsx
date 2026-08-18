'use client';

/**
 * App-wide toast host. Mounted once in `AppProviders`, so any client component
 * can call `notify.*` from `@/lib/notify` without rendering its own container.
 *
 * Dark mode is deliberately NOT driven by the `theme` prop. react-toastify
 * stamps the theme onto each toast when it is created, so a toast raised after
 * the user flips the theme still carried the old palette. Instead the container
 * is pinned to `theme="light"` and `styles/components/toast.css` redefines the
 * `--toastify-*-light` tokens under `:root.dark`. The palette then follows the
 * same `.dark` class as the rest of the app, with no JS in the loop and no
 * hydration gate.
 *
 * The rest of the visual styling lives in that same stylesheet.
 */

import { ToastContainer, Slide } from 'react-toastify';
import { appConfig } from '@/config/app.config';

export function Toaster() {
  return (
    <ToastContainer
      position="bottom-right"
      autoClose={appConfig.ui.toastDuration}
      limit={4}
      stacked
      newestOnTop
      closeOnClick={false}
      pauseOnHover
      pauseOnFocusLoss
      draggable
      draggablePercent={40}
      transition={Slide}
      theme="light"
      aria-label="Notifications"
    />
  );
}
