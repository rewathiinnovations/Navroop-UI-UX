import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  // Lighthouse uses `await import(requirePath)` which Turbopack cannot bundle.
  serverExternalPackages: ['lighthouse', 'chrome-launcher', 'lighthouse-logger'],
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

export default nextConfig;
