/**
 * Sandbox driver contract.
 *
 * Multiple configs are for genuinely different providers or legitimately
 * separate accounts (dev vs prod). Creating several free accounts with one
 * provider to extend a free allowance breaks that provider's terms and risks
 * all being closed at once.
 */

export const SANDBOX_DRIVERS = ['e2b', 'modal', 'daytona'] as const;
export type SandboxDriverId = (typeof SANDBOX_DRIVERS)[number];

export type CreditType = 'recurring_monthly' | 'one_time' | 'paid';
export type RoutingStrategy = 'free_first' | 'priority' | 'round_robin' | 'cheapest';

export const DEFAULT_ROUTING_STRATEGY: RoutingStrategy = 'free_first';
export const STRATEGY_SETTING_KEY = 'sandbox.routingStrategy';

export const LAST_ACTIVE_DEACTIVATE_WARNING = 'After this, no generation will be able to run';
export const FREE_FIRST_STRATEGY_HELP =
  'Use monthly free credit first, then one-time credit. Known-healthy rows outrank unchecked; unchecked outrank degraded.';
export const NO_PROVIDER_GENERATION_MESSAGE =
  'No sandbox provider is available. An admin must add or reactivate a provider before generation can run.';
export const ADD_PROVIDER_LABEL = 'Add provider';
export const TEST_PROVIDER_LABEL = 'Test';
export const DEFAULT_ORDER_NOTE =
  'Default order uses monthly free credit first, then the smallest one-time pool. Known-healthy rows outrank unchecked ones; unchecked outrank degraded. Do not reorder by priority in a way that burns one-time credit while monthly credit is still unused.';

export const STRATEGY_HELP: Record<RoutingStrategy, string> = {
  free_first: FREE_FIRST_STRATEGY_HELP,
  priority: 'Use the highest-priority known-healthy provider, then unchecked, then degraded',
  round_robin: 'Spread new sandboxes across the healthiest eligible band by weight',
  cheapest: 'Prefer the lowest estimated run cost among known-healthy rows, then unchecked, then degraded',
};

export type DriverCapabilities = {
  publicPreviewUrl: boolean;
  snapshots: boolean;
  persistentFilesystem: boolean;
  regions: string[];
};

export type DriverCostModel = {
  cpuPerSecUsd: number;
  memPerGibSecUsd: number;
};

export const DRIVER_CAPABILITIES: Record<SandboxDriverId, DriverCapabilities> = {
  e2b: {
    publicPreviewUrl: true,
    snapshots: true,
    persistentFilesystem: false,
    regions: ['us-east', 'eu-central'],
  },
  modal: {
    publicPreviewUrl: true,
    snapshots: false,
    persistentFilesystem: true,
    regions: ['us-east', 'us-west', 'eu-west'],
  },
  daytona: {
    publicPreviewUrl: true,
    snapshots: true,
    persistentFilesystem: true,
    regions: ['us', 'eu'],
  },
};

/** List prices used for estimates. Admin-entered credit figures are authoritative. */
export const DRIVER_COST_MODELS: Record<SandboxDriverId, DriverCostModel> = {
  e2b: { cpuPerSecUsd: 0.000028, memPerGibSecUsd: 0.000012 },
  modal: { cpuPerSecUsd: 0.0000131, memPerGibSecUsd: 0.00000222 },
  daytona: { cpuPerSecUsd: 0.00002, memPerGibSecUsd: 0.00001 },
};

export type E2BSecrets = { apiKey: string };
export type ModalSecrets = { tokenId: string; tokenSecret: string };
export type DaytonaSecrets = { apiKey: string; apiUrl?: string };
export type DriverSecrets = E2BSecrets | ModalSecrets | DaytonaSecrets;

export type ProviderRuntimeConfig = {
  cpu?: number;
  memoryGiB?: number;
  region?: string;
  timeoutMs?: number;
};

export type ExclusionReason = {
  id: string;
  name: string;
  reason: string;
};

export class NoProviderAvailableError extends Error {
  readonly exclusions: ExclusionReason[];

  constructor(exclusions: ExclusionReason[] = []) {
    super(NO_PROVIDER_GENERATION_MESSAGE);
    this.name = 'NoProviderAvailableError';
    this.exclusions = exclusions;
  }
}

export type InjectedSandboxClient = {
  create: (opts?: Record<string, unknown>) => Promise<{ id: string; previewUrl?: string | null }>;
  run: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  writeFile: (path: string, content: string) => Promise<void>;
  readFile: (path: string) => Promise<string>;
  listFiles: (directory?: string) => Promise<string[]>;
  kill: () => Promise<void>;
  reconnect: (sandboxId: string) => Promise<boolean>;
  getPreviewUrl: () => string | null;
};

export function isSandboxDriver(value: string): value is SandboxDriverId {
  return (SANDBOX_DRIVERS as readonly string[]).includes(value);
}

const DRIVER_LABEL: Record<SandboxDriverId, string> = {
  e2b: 'E2B',
  modal: 'Modal',
  daytona: 'Daytona',
};

export function sandboxDriverLabel(driver: string): string {
  return DRIVER_LABEL[driver as SandboxDriverId] ?? driver;
}

export function credentialFields(driver: SandboxDriverId) {
  if (driver === 'e2b') {
    return {
      fields: [{ key: 'apiKey', label: 'API key', type: 'password' as const }],
      where: 'Create an API key in the E2B dashboard.',
      href: 'https://e2b.dev/docs/api-key',
    };
  }
  if (driver === 'modal') {
    return {
      fields: [
        { key: 'tokenId', label: 'Token ID', type: 'text' as const },
        { key: 'tokenSecret', label: 'Token secret', type: 'password' as const },
      ],
      where: 'Create a token ID and secret in Modal workspace settings.',
      href: 'https://modal.com/settings/tokens',
    };
  }
  return {
    fields: [
      { key: 'apiKey', label: 'API key', type: 'password' as const },
      { key: 'apiUrl', label: 'API URL (optional)', type: 'text' as const },
    ],
    where: 'Create an API key in the Daytona dashboard.',
    href: 'https://app.daytona.io/dashboard/keys',
  };
}
