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
  /**
   * GitHub's `repository_selection` for the adopted installation: `'selected'` when the
   * operator picked individual repositories, `'all'` when the App can reach every repository
   * in the account. The App asks for `contents: write` **and** `administration: write`
   * (github-manifest.ts), so under `'all'` any bug on the publish path — F-202 was a
   * force-push over an unrelated repository — has the whole account as its blast radius.
   * Recorded so /admin/integrations can say so out loud (F-270). Never a gate: revoking
   * access is the operator's call to make on GitHub, not ours to enforce by refusing to
   * publish.
   */
  repositorySelection?: 'all' | 'selected';
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

/**
 * `pendingToken` is a candidate credential a half-finished connect wizard staged. It is
 * deliberately not `token`: writing the live field (and flipping the row to PENDING) took
 * publishing down workspace-wide the moment an admin pasted a token to re-check it, before
 * they had picked a zone or a server (F-214). Promotion to `token` happens on completion.
 */
export type CloudflareSecrets = {
  token?: string;
  pendingToken?: string;
};

export type CoolifyConfig = {
  baseUrl?: string;
  /** Candidate base URL from an in-progress connect wizard. See `pendingToken`. */
  pendingBaseUrl?: string;
  projectUuid?: string;
  projectName?: string;
  serverCount?: number;
};

export type CoolifySecrets = {
  token?: string;
  pendingToken?: string;
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

/** The two columns the publish gate reads, plus whether the blob decrypted (F-212). */
export type IntegrationRow = {
  kind: IntegrationKind | string;
  status: IntegrationStatus | string;
  secretsUnreadable?: boolean;
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
  /**
   * Deploy app only — where GitHub delivers the events the app subscribes to. Omitted for
   * the connectors app, which subscribes to nothing (F-265).
   */
  hook_attributes?: { url: string; active: boolean };
  /** Event names. Empty means "deliver nothing", which is the connectors app's contract. */
  default_events: string[];
};
