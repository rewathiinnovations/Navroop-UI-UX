import { withSentryConfig } from '@sentry/nextjs';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Lighthouse uses `await import(requirePath)` which Turbopack cannot bundle.
  // @daytona/sdk dynamically requires form-data for file uploads; bundled, that
  // require fails at runtime ("not available in the node runtime") and every
  // Daytona build dies at the first file write. Keep both external.
  serverExternalPackages: [
    'lighthouse',
    'chrome-launcher',
    'lighthouse-logger',
    'form-data',
    // Native binary with per-platform optional deps — bundling it breaks the
    // server-side preview build.
    'esbuild',
  ],
  outputFileTracingIncludes: {
    '/*': ['./generated/prisma/**/*'],
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'www.google.com',
      },
      {
        protocol: 'https',
        hostname: 'storage.googleapis.com',
      },
    ],
  },
};

/**
 * Source-map upload targets whatever Sentry the operator connected, not one specific org.
 * `org: 'rewathi'` / `project: 'navroop-nextjs'` were literals here while every other
 * Sentry setting comes from the `Integration` store, so a self-hosting operator's release
 * artefacts were pushed at someone else's org — or failed with a confusing auth error
 * (F-762). `SENTRY_ORG` / `SENTRY_PROJECT` are the names `migrateEnvSentry` already reads,
 * and they are build-time: they are consumed by `next build`, so changing them needs a
 * rebuild, not a restart.
 */
const sentryOrg = process.env.SENTRY_ORG?.trim() || '';
const sentryProject = process.env.SENTRY_PROJECT?.trim() || '';
const uploadSourceMaps = Boolean(
  sentryOrg && sentryProject && process.env.SENTRY_AUTH_TOKEN?.trim(),
);

export default withSentryConfig(nextConfig, {
  org: sentryOrg || undefined,
  project: sentryProject || undefined,

  // Nothing to upload to without all three, and the plugin's failure without them is an
  // auth error in the middle of a build rather than a missing-configuration message.
  sourcemaps: { disable: !uploadSourceMaps },

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Uncomment to route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  // tunnelRoute: "/monitoring",

  // `webpack` is where @sentry/nextjs 10.70 expects these (the top-level spellings are
  // deprecated in favour of it), and the whole sub-object applies only to webpack builds.
  // `automaticVercelMonitors` used to sit here set to `true`: it instruments Vercel cron
  // jobs declared in `vercel.json`, this app deploys to Coolify and has no `vercel.json`,
  // and its own docs exclude App Router route handlers — three reasons it did nothing
  // while reading as active tuning (F-762).
  webpack: {
    treeshake: {
      // Drops Sentry's own logger statements. Inert under `next build` with Turbopack;
      // kept for a webpack fallback build.
      removeDebugLogging: true,
    },
  },
});
