import {
  ADD_PROVIDER_LABEL,
  DEFAULT_ORDER_NOTE,
  FREE_FIRST_STRATEGY_HELP,
  LAST_ACTIVE_DEACTIVATE_WARNING,
  TEST_PROVIDER_LABEL,
} from '@/lib/sandbox/provider';
import { capabilityMatrix, strategyOptions, toPublicProvider } from '@/lib/sandbox/public';
import { rankAndSelect, toCandidate } from '@/lib/sandbox/router';
import { getRoutingStrategy, listProviderConfigs } from '@/lib/sandbox/store';

export type SandboxProvidersAdminPayload = {
  providers: ReturnType<typeof toPublicProvider>[];
  strategy: string;
  nextPickReason: string | null;
  strategies: Array<{ id: string; help: string; selected: boolean }>;
  capabilities: ReturnType<typeof capabilityMatrix>;
  labels: {
    addProvider: string;
    test: string;
    freeFirst: string;
    lastActive: string;
    defaultOrder: string;
  };
};

function toWireProvider(row: ReturnType<typeof toPublicProvider>) {
  return {
    ...row,
    monthsRemaining: Number.isFinite(row.monthsRemaining) ? row.monthsRemaining : null,
  };
}

/** Same payload as GET /api/admin/sandbox-providers, safe for RSC + hydration. */
export async function loadSandboxProvidersAdmin(): Promise<SandboxProvidersAdminPayload> {
  const rows = await listProviderConfigs();
  const strategy = await getRoutingStrategy();
  let ordered = rows;
  let nextPickReason: string | null = null;
  try {
    const first = rankAndSelect({
      candidates: rows.map(toCandidate),
      strategy,
      estimateSeconds: 1,
    });
    nextPickReason = first.selectionReason ?? null;
    ordered = [
      rows.find((row) => row.id === first.id)!,
      ...rows.filter((row) => row.id !== first.id),
    ];
  } catch {
    ordered = rows;
  }
  return {
    providers: ordered.filter(Boolean).map((row) => toWireProvider(toPublicProvider(row))),
    strategy,
    nextPickReason,
    strategies: strategyOptions(strategy),
    capabilities: capabilityMatrix(),
    labels: {
      addProvider: ADD_PROVIDER_LABEL,
      test: TEST_PROVIDER_LABEL,
      freeFirst: FREE_FIRST_STRATEGY_HELP,
      lastActive: LAST_ACTIVE_DEACTIVATE_WARNING,
      defaultOrder: DEFAULT_ORDER_NOTE,
    },
  };
}
