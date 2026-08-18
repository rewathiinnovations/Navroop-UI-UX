import { prisma } from '@/lib/db';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { ensureWorkspace } from './limits';

/**
 * Payment providers plug in here. Business limits stay in limits.ts.
 * Today ADMIN assigns plans manually. A Stripe (or other) provider later
 * should call assignWorkspacePlan after a successful checkout/webhook.
 */
export type BillingProvider = {
  id: 'manual' | 'stripe';
  assignWorkspacePlan: (workspaceId: string, planId: string) => Promise<void>;
  createCheckoutSession?: (input: {
    workspaceId: string;
    planId: string;
    successUrl: string;
    cancelUrl: string;
  }) => Promise<{ url: string }>;
};

export async function assignWorkspacePlan(workspaceId: string, planId: string) {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) throw new Error('Plan not found');
  await ensureWorkspace(workspaceId);
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { planId: plan.id },
  });
}

export const billingProvider: BillingProvider = {
  id: 'manual',
  assignWorkspacePlan,
};

export function defaultWorkspaceId() {
  return WORKSPACE_ROW_ID;
}
