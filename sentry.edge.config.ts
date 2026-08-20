// Edge/middleware error reporting. The isolate cannot read OBSERVABILITY_CONFIG_PATH
// (no node fs), so the DSN saved in /admin/integrations never reaches it; the one value it
// can carry is the build-time NEXT_PUBLIC_SENTRY_DSN literal. See lib/sentry/edge.ts for
// why, and /admin/health for the disclosure when it is absent (F-786).
import * as Sentry from '@sentry/nextjs';
import { observabilityBeforeSend } from '@/lib/observability/noise';
import { edgeSentryDsn } from '@/lib/sentry/edge';

const dsn = edgeSentryDsn();

if (dsn) {
  Sentry.init({
    dsn,
    // NODE_ENV, not the `environment` from the runtime config: that file is unreadable here,
    // and a wrong environment tag is worse than a coarse one.
    environment: process.env.NODE_ENV,
    // Performance sampling is a runtime-config knob this isolate cannot read, so edge
    // reports errors only. Traces still come from the Node server and the browser.
    tracesSampleRate: 0,
    // The same suppression and secret scrubbing the Node and browser inits use.
    beforeSend: observabilityBeforeSend,
    sendDefaultPii: false,
  });
}
