export const PUBLISH_INTEGRATION_KINDS = ['GITHUB_DEPLOY', 'CLOUDFLARE', 'COOLIFY'] as const;
export const INTEGRATION_KINDS = [...PUBLISH_INTEGRATION_KINDS, 'SENTRY'] as const;
export type PublishIntegrationKind = (typeof PUBLISH_INTEGRATION_KINDS)[number];
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export const INTEGRATION_STATUSES = ['DISCONNECTED', 'PENDING', 'CONNECTED', 'ERROR'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const KIND_LABELS: Record<IntegrationKind, string> = {
  GITHUB_DEPLOY: 'GitHub',
  CLOUDFLARE: 'Cloudflare',
  COOLIFY: 'Coolify',
  SENTRY: 'Sentry',
};

export type GithubConfig = {
  appId?: number | string;
  slug?: string;
  htmlUrl?: string;
  org?: string;
  installationId?: string;
  accountLogin?: string;
};

export type GithubSecrets = {
  pem?: string;
  webhookSecret?: string;
  clientId?: string;
  clientSecret?: string;
};

export type CloudflareConfig = {
  zoneId?: string;
  zoneName?: string;
  accountId?: string;
};

export type CloudflareSecrets = {
  token?: string;
};

export type CoolifyConfig = {
  baseUrl?: string;
  projectUuid?: string;
  projectName?: string;
  serverCount?: number;
};

export type CoolifySecrets = {
  token?: string;
};

export type SentryConfig = {
  orgSlug?: string;
  projectSlug?: string;
  projectId?: string;
  dsn?: string;
  environment?: string;
  tracesSampleRate?: number;
  region?: string;
  installationUuid?: string;
  installationName?: string;
  host?: string;
  sessionReplay?: boolean;
  performance?: boolean;
  ignoreList?: string[];
  fingerprintLimit?: number;
  fingerprintWindowSec?: number;
  limited?: boolean;
  oauthClientId?: string;
};

export type SentrySecrets = {
  authToken?: string;
  refreshToken?: string;
  clientSecret?: string;
  tokenExpiresAt?: string;
};

export type IntegrationSecrets = GithubSecrets & CloudflareSecrets & CoolifySecrets & SentrySecrets;

export type IntegrationConfig = GithubConfig & CloudflareConfig & CoolifyConfig & SentryConfig;

export type IntegrationRow = {
  kind: IntegrationKind | string;
  status: IntegrationStatus | string;
};

export type CloudflareZone = {
  id: string;
  name: string;
  account?: { id?: string };
};

export type GithubManifest = {
  name: string;
  url: string;
  redirect_url: string;
  /** OAuth callback(s) — required for apps whose users authorize (connectors). */
  callback_urls?: string[];
  /** Deploy app only — the connectors app has no post-install setup page. */
  setup_url?: string;
  public: false;
  default_permissions: Record<string, 'read' | 'write'>;
  default_events: [];
};
