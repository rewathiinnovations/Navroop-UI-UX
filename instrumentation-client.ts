// Client Sentry init for Next.js 16. Shared with sentry.client.config.ts.

import * as Sentry from '@sentry/nextjs';
import { initSentryClient } from '@/lib/sentry/client';

initSentryClient();

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
