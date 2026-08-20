import type { DeploymentKind, DeploymentStatus } from '@/generated/prisma';

/**
 * The deployment payload two `'use client'` components render. It lives here,
 * not in `serialize.ts`, because that module value-imports `./slug` and so
 * reaches `@/lib/db`. The client boundary guard stops at type-only edges, so the
 * import compiled today — but dropping the `type` keyword would have put Prisma
 * in the browser graph and turned /deployments into a cold-compile 500 (F-241).
 * Nothing runtime may be imported here.
 */
export type PublicDeployment = {
  id: string;
  projectId: string;
  workspaceId: string;
  kind: DeploymentKind;
  status: DeploymentStatus;
  slug: string;
  url: string | null;
  expectedUrl: string;
  progressStep: string | null;
  lastError: string | null;
  lastRequestId: string | null;
  buildLogUrl: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  hasPassword: boolean;
  publishedBy: { id: string; name: string } | null;
  projectName?: string;
  canonicalUrl: string;
};
