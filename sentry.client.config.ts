// Client Sentry init. Next.js 16 also loads instrumentation-client.ts —
// init is guarded so both files can exist without double-init.

import { initSentryClient } from '@/lib/sentry/client';

initSentryClient();
