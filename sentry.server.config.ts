// This file configures the initialization of Sentry on the server.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';
import { buildSentryInitOptions } from '@/lib/sentry/options';

const options = buildSentryInitOptions();
if (options) {
  Sentry.init(options);
}
