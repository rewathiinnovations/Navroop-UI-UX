/**
 * Every value an operator can configure from /admin/config.
 *
 * One entry per setting. `env` names the variable that used to be the only way
 * to set it — it stays readable as a fallback so an existing deployment keeps
 * working untouched, but a value saved in the admin UI always wins.
 *
 * Adding a setting here is enough to make it appear on /admin/config; the page
 * renders from this list rather than from hand-written markup.
 */

export const SETTING_GROUPS = [
  {
    id: 'connectors',
    label: 'Connectors',
    blurb: 'Lets members link their own accounts from the Connectors page.',
  },
  {
    id: 'ai',
    label: 'AI providers',
    blurb: 'The DeepSeek credential used to plan and write code. Generation cannot run without it.',
  },
  {
    id: 'tooling',
    label: 'Content & tooling',
    blurb: 'Services used for site imports and stock imagery.',
  },
  {
    id: 'email',
    label: 'Email',
    blurb: 'Used for invitations and password resets.',
  },
  {
    id: 'storage',
    label: 'Storage',
    blurb: 'Where uploaded assets and template thumbnails are kept.',
  },
  {
    id: 'backups',
    label: 'Backups',
    blurb: 'Where nightly database backups are written.',
  },
  {
    id: 'app',
    label: 'Application',
    blurb: 'General behaviour of this installation.',
  },
] as const;

export type SettingGroupId = (typeof SETTING_GROUPS)[number]['id'];

export type SettingKind = 'text' | 'secret' | 'url' | 'number' | 'select';

export type SettingEntry = {
  /** Stable storage key. Never rename — it is the AppSetting primary key. */
  key: string;
  group: SettingGroupId;
  label: string;
  /** Plain-language explanation shown under the field. No internal jargon. */
  help: string;
  kind: SettingKind;
  /** Environment variable read when nothing is saved in the database. */
  env?: string;
  /** Older environment names still honoured, tried in order after `env`. */
  envAliases?: readonly string[];
  /** Used when neither the database nor the environment has a value. */
  fallback?: string;
  /** Choices for `kind: 'select'`. */
  options?: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
};

export const SETTINGS: readonly SettingEntry[] = [
  // ---------------------------------------------------------------- connectors
  {
    key: 'github.oauth.clientId',
    group: 'connectors',
    label: 'GitHub OAuth client ID',
    help: 'From the GitHub OAuth App you created for this installation. Without it, the Connect button on the Connectors page cannot start.',
    kind: 'text',
    env: 'GITHUB_OAUTH_CLIENT_ID',
    placeholder: 'Iv1.0123456789abcdef',
  },
  {
    key: 'github.oauth.clientSecret',
    group: 'connectors',
    label: 'GitHub OAuth client secret',
    help: 'Generated next to the client ID on the same GitHub OAuth App page.',
    kind: 'secret',
    env: 'GITHUB_OAUTH_CLIENT_SECRET',
  },
  {
    key: 'github.oauth.callbackUrl',
    group: 'connectors',
    label: 'GitHub OAuth callback URL',
    help: 'Must match the Authorization callback URL registered on the GitHub OAuth App, exactly.',
    kind: 'url',
    env: 'GITHUB_OAUTH_CALLBACK_URL',
    fallback: 'http://localhost:3000/api/github/callback',
  },

  // ----------------------------------------------------------------------- ai
  {
    key: 'ai.deepseek.apiKey',
    group: 'ai',
    label: 'DeepSeek API key',
    help: 'The only AI provider. Plans and builds stop working without it.',
    kind: 'secret',
    env: 'DEEPSEEK_API_KEY',
  },
  {
    key: 'ai.deepseek.baseUrl',
    group: 'ai',
    label: 'DeepSeek base URL',
    help: 'Leave blank unless you route DeepSeek traffic through a proxy or gateway.',
    kind: 'url',
    env: 'DEEPSEEK_BASE_URL',
    fallback: 'https://api.deepseek.com',
  },
  {
    key: 'ai.primaryModel',
    group: 'ai',
    label: 'Model',
    help: 'Which DeepSeek model writes plans and code.',
    kind: 'select',
    env: 'AI_PRIMARY_MODEL',
    fallback: 'deepseek-v4-flash',
    options: [
      { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash — faster, cheaper' },
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro — strongest' },
    ],
  },
  {
    key: 'ai.concurrency',
    group: 'ai',
    label: 'Concurrent generations',
    help: 'How many generation requests may run at once. Raise it only if your DeepSeek quota allows.',
    kind: 'number',
    env: 'AI_PROVIDER_CONCURRENCY',
    // Must stay in step with the queue's own default in lib/ai/queue.ts. This
    // read '4' while the queue ran at 2, so the screen advertised headroom the
    // runtime never had.
    fallback: '2',
  },
  {
    key: 'ai.fileContextTokenCap',
    group: 'ai',
    label: 'Follow-up file context cap (tokens)',
    help: 'How much of an existing project is shown to the model when someone asks for a change. Raising it means the model sees more of the project and every follow-up costs more; lowering it means it may edit a file it was never shown. 30000 is the built-in default.',
    kind: 'number',
    // Was env-only, which made a spend knob invisible on this page and untraceable in the
    // audit log (F-094). The variable still works as the fallback.
    env: 'NAVROOP_FILE_CONTEXT_TOKEN_CAP',
    fallback: '30000',
  },
  {
    key: 'ai.cost.inputPerMillionUsd',
    group: 'ai',
    label: 'Input token price (USD per million)',
    help: 'What DeepSeek charges you for a million input tokens. Leave blank to use the built-in list price of 0.27 (fast) / 0.55 (strongest) — those are transcribed from DeepSeek\u2019s public page, not from your invoice, and every cost figure and the workspace spend limit are calculated from them. Check one bill and enter the real number.',
    kind: 'number',
    placeholder: '0.27',
  },
  {
    key: 'ai.cost.outputPerMillionUsd',
    group: 'ai',
    label: 'Output token price (USD per million)',
    help: 'What DeepSeek charges you for a million output tokens. Leave blank to use the built-in list price of 1.10 (fast) / 2.19 (strongest). Both prices must be filled in for either to be used, so a half-entered pair keeps the built-in defaults.',
    kind: 'number',
    placeholder: '1.10',
  },

  // ------------------------------------------------------------------ tooling
  {
    key: 'tooling.firecrawl.apiKey',
    group: 'tooling',
    label: 'Firecrawl API key',
    help: 'Used when someone imports an existing website by URL. Imports fail without it.',
    kind: 'secret',
    env: 'FIRECRAWL_API_KEY',
  },
  {
    key: 'tooling.unsplash.accessKey',
    group: 'tooling',
    label: 'Unsplash access key',
    help: 'Optional. Supplies stock photography to generated sites; placeholders are used without it.',
    kind: 'secret',
    env: 'UNSPLASH_ACCESS_KEY',
  },
  {
    key: 'tooling.unsplash.applicationId',
    group: 'tooling',
    label: 'Unsplash application ID',
    help: 'Not in use. Reference only: the numeric id of the Unsplash application the access key belongs to, so an operator can tell which app to rotate. Nothing sends it anywhere.',
    kind: 'text',
    env: 'UNSPLASH_APPLICATION_ID',
  },
  {
    key: 'tooling.unsplash.secretKey',
    group: 'tooling',
    label: 'Unsplash secret key',
    help: 'Not in use. Only Unsplash OAuth on behalf of a signed-in user would need it; photo search and download authenticate with the access key alone. Stored so the credential set stays together.',
    kind: 'secret',
    env: 'UNSPLASH_SECRET_KEY',
  },
  {
    key: 'tooling.images.workerUrl',
    group: 'tooling',
    label: 'Image worker URL',
    help: 'Self-hosted Cloudflare Worker that generates every picture a build asks for. It must accept POST / with a JSON body of {"prompt","model"} and answer with image bytes. Without it, generation falls back to an OpenAI or Google key, then to stock photography.',
    kind: 'url',
    env: 'IMAGE_WORKER_URL',
  },
  {
    key: 'tooling.images.token',
    group: 'tooling',
    label: 'Image worker token',
    help: 'Bearer token the worker checks against its own API_KEY binding. Sent as an Authorization header on every image request; the endpoint is not called at all without it.',
    kind: 'secret',
    env: 'IMAGE_WORKER_TOKEN',
  },
  {
    key: 'tooling.images.model',
    group: 'tooling',
    label: 'Image model',
    help: 'Which model the worker runs. Only the models below were verified to return an image through this worker: the rest of its alias list answers "Unexpected model output format" (Phoenix, SDXL) or needs a different request shape (FLUX.2 Dev wants multipart). A full provider id also passes straight through if you extend the worker.',
    kind: 'select',
    env: 'IMAGE_WORKER_MODEL',
    fallback: 'lucid-origin',
    options: [
      { value: 'lucid-origin', label: 'Leonardo Lucid Origin — default, ~12s' },
      { value: 'flux-2-klein-4b', label: 'FLUX.2 Klein 4B — ~12s' },
      { value: 'flux-2-klein-9b', label: 'FLUX.2 Klein 9B — larger' },
      { value: 'flux-1-schnell', label: 'FLUX.1 Schnell — fastest' },
    ],
  },

  // -------------------------------------------------------------------- email
  {
    key: 'email.resend.apiKey',
    group: 'email',
    label: 'Resend API key',
    help: 'Sends invitations and password-reset emails. Without it, those emails are skipped and reset links must be copied manually from the Team page.',
    kind: 'secret',
    env: 'RESEND_API_KEY',
  },
  {
    key: 'email.from',
    group: 'email',
    label: 'From address',
    help: 'The sender shown on outgoing email. Must be on a domain verified with your email provider.',
    kind: 'text',
    env: 'EMAIL_FROM',
    placeholder: 'Navroop <no-reply@example.com>',
  },

  // ------------------------------------------------------------------ storage
  {
    key: 'storage.driver',
    group: 'storage',
    label: 'Storage driver',
    help: 'Local disk is fine for a single server. S3-compatible object storage is required if you run more than one.',
    kind: 'select',
    env: 'STORAGE_DRIVER',
    fallback: 'local',
    options: [
      { value: 'local', label: 'Local disk' },
      { value: 's3', label: 'S3-compatible' },
    ],
  },
  {
    key: 'storage.localDir',
    group: 'storage',
    label: 'Local storage directory',
    help: 'Used when the driver is Local disk. Must be writable and should sit on a persistent volume.',
    kind: 'text',
    env: 'STORAGE_LOCAL_DIR',
  },
  {
    key: 'storage.s3.endpoint',
    group: 'storage',
    label: 'S3 endpoint',
    help: 'Base address of the object store, for example https://s3.eu-central-1.amazonaws.com or the equivalent for your provider.',
    kind: 'url',
    env: 'ELK_ENDPOINT',
    envAliases: ['S3_ENDPOINT'],
  },
  {
    key: 'storage.s3.region',
    group: 'storage',
    label: 'S3 region',
    help: 'Region of the bucket. Providers that do not use regions accept "auto".',
    kind: 'text',
    env: 'ELK_REGION',
    envAliases: ['S3_REGION'],
    fallback: 'auto',
  },
  {
    key: 'storage.s3.bucket',
    group: 'storage',
    label: 'S3 bucket',
    help: 'Bucket that holds assets and thumbnails. It must allow public reads, or images will not load in generated sites.',
    kind: 'text',
    env: 'ELK_BUCKET',
    envAliases: ['S3_BUCKET'],
  },
  {
    key: 'storage.s3.accessKeyId',
    group: 'storage',
    label: 'S3 access key ID',
    help: 'Identifier half of the credential used to write to the bucket.',
    kind: 'text',
    env: 'ELK_ACCESS_KEY_ID',
    envAliases: ['S3_ACCESS_KEY_ID'],
  },
  {
    key: 'storage.s3.secretAccessKey',
    group: 'storage',
    label: 'S3 secret access key',
    help: 'Secret half of the credential used to write to the bucket.',
    kind: 'secret',
    env: 'ELK_SECRET_ACCESS_KEY',
    envAliases: ['S3_SECRET_ACCESS_KEY'],
  },
  {
    key: 'storage.s3.publicUrl',
    group: 'storage',
    label: 'S3 public URL',
    help: 'The base URL that serves stored files to browsers, for example a CDN in front of the bucket.',
    kind: 'url',
    env: 'S3_PUBLIC_URL',
    envAliases: ['ELK_PUBLIC_URL'],
  },
  {
    key: 'storage.orphanGraceDays',
    group: 'storage',
    label: 'Orphaned object grace period (days)',
    help: 'How long a stored file with nothing in the database pointing at it is left alone before the weekly storage check counts it as reclaimable. An upload is written seconds before the row that references it, so a short grace period would flag files that are about to be claimed.',
    kind: 'number',
    fallback: '14',
  },
  {
    key: 'storage.orphanAction',
    group: 'storage',
    label: 'Orphaned objects',
    help: 'Report only counts them on the Backups page. Delete also removes those older than the grace period during the weekly storage check. Start with Report, confirm the count looks like abandoned uploads and not your live files, then switch.',
    kind: 'select',
    fallback: 'report',
    options: [
      { value: 'report', label: 'Report only' },
      { value: 'delete', label: 'Delete after the grace period' },
    ],
  },

  // ------------------------------------------------------------------ backups
  {
    key: 'backups.bucket',
    group: 'backups',
    label: 'Backup bucket',
    help: 'Object-storage bucket that nightly database backups are written to.',
    kind: 'text',
    env: 'BACKUP_BUCKET',
  },
  {
    key: 'backups.endpoint',
    group: 'backups',
    label: 'Backup endpoint',
    help: 'Storage endpoint for the backup bucket. Leave blank for AWS S3 itself.',
    kind: 'url',
    env: 'BACKUP_ENDPOINT',
  },
  {
    key: 'backups.region',
    group: 'backups',
    label: 'Backup region',
    help: 'Region of the backup bucket.',
    kind: 'text',
    env: 'BACKUP_REGION',
  },
  {
    key: 'backups.accessKeyId',
    group: 'backups',
    label: 'Backup access key ID',
    help: 'Identifier half of the credential used to write backups. Use a separate credential from application storage, so a compromise of one does not reach the other.',
    kind: 'text',
    env: 'BACKUP_ACCESS_KEY_ID',
  },
  {
    key: 'backups.secretAccessKey',
    group: 'backups',
    label: 'Backup secret access key',
    help: 'Secret half of the backup credential.',
    kind: 'secret',
    env: 'BACKUP_SECRET_ACCESS_KEY',
  },
  {
    key: 'backups.localDir',
    group: 'backups',
    label: 'Local backup directory',
    help: 'Used instead of a bucket when set. Suitable for development only — a backup on the same disk as the database is not a backup.',
    kind: 'text',
    env: 'BACKUP_LOCAL_DIR',
  },

  // ---------------------------------------------------------------------- app
  {
    key: 'app.url',
    group: 'app',
    label: 'Application URL',
    help: 'The public address of this installation. Used in password-reset links, the GitHub App callback, and the certificate and uptime checks. Preview pages read the APP_URL environment variable instead, so they only follow a change here after a redeploy.',
    kind: 'url',
    env: 'APP_URL',
    // The aliases every consumer already accepted. Listing them here is what
    // makes /admin/config say "Set from environment" on an install that only
    // ever set NEXTAUTH_URL, instead of showing the field as unconfigured.
    envAliases: ['NEXTAUTH_URL', 'AUTH_URL', 'NEXT_PUBLIC_APP_URL'],
    placeholder: 'https://navroop.example.com',
  },
  {
    key: 'preview.host',
    group: 'app',
    label: 'Preview host',
    help: 'A hostname that points at this same application and is used only to serve generated previews, so their scripts run on a different origin from the app itself. One DNS record pointed at this server is enough. Filled automatically when a Cloudflare zone is connected; without either, previews cannot be opened in a new tab (the in-app preview keeps working).',
    kind: 'text',
    env: 'PREVIEW_STATIC_HOST',
    placeholder: 'preview.navroop.example.com',
  },
  {
    key: 'app.cronSecret',
    group: 'app',
    label: 'Scheduled-task secret',
    help: 'Shared secret an external scheduler must present to trigger nightly jobs. Leave blank to disable remote triggering.',
    kind: 'secret',
    env: 'CRON_SECRET',
  },
  {
    key: 'observability.deadManUrl',
    group: 'app',
    label: 'Monitoring heartbeat URL',
    help: 'The daily system-checks digest calls this address every time it runs. Point it at an external monitor that expects a regular ping (Healthchecks.io, Better Stack, Uptime Kuma "push") and alerts when one does not arrive: that alert is the only thing that can tell you the digest itself stopped running, because the digest is what reports every other scheduled task. Leave blank to disable.',
    kind: 'url',
    placeholder: 'https://hc-ping.com/your-check-uuid',
  },
  {
    key: 'app.checkpointRetentionDays',
    group: 'app',
    label: 'Checkpoint retention (days)',
    help: 'How long project checkpoints are kept before being cleaned up.',
    kind: 'number',
    env: 'CHECKPOINT_RETENTION_DAYS',
    fallback: '7',
  },
  {
    key: 'app.workspaceName',
    group: 'app',
    label: 'Workspace name',
    help: 'Used when this product creates things on your behalf — the GitHub App is named "Navroop Deploy — <name>" and a new Sentry project takes this name. Applies on the next connect; no rebuild needed.',
    kind: 'text',
    env: 'WORKSPACE_NAME',
    // The old name. It is a build-time variable, which is why the server-side reads moved
    // here (F-240), but an existing deployment that only sets it must keep working.
    envAliases: ['NEXT_PUBLIC_WORKSPACE_NAME'],
    fallback: 'Navroop',
  },
  {
    key: 'app.purgeDeletedDays',
    group: 'app',
    label: 'Deleted project retention (days)',
    help: 'How long a deleted project can still be restored before it is purged for good.',
    kind: 'number',
    env: 'PURGE_DELETED_DAYS',
    fallback: '30',
  },
  {
    key: 'app.certWarningDays',
    group: 'app',
    label: 'Certificate warning (days)',
    help: 'How long before your TLS certificate expires the daily certificate check starts failing, so there is still time to renew. Shorter means fewer warnings and less time to act.',
    kind: 'number',
    fallback: '14',
  },
  {
    key: 'app.observabilityRetentionDays',
    group: 'app',
    label: 'Scheduled-task history (days)',
    help: 'How long the record of scheduled-task runs and health checks is kept. The most recent run of each task is always kept regardless of age, because that is the row the health page reads. Nothing in the product looks further back than a day, so this only affects how much history you can inspect by hand.',
    kind: 'number',
    fallback: '30',
  },
  {
    key: 'app.sentryQuotaWarnPercent',
    group: 'app',
    label: 'Error-tracking quota warning (%)',
    help: 'How much of your Sentry monthly event quota may be used before the daily check emails a warning. Above this level Sentry starts dropping events, so errors stop arriving without anything failing.',
    kind: 'number',
    fallback: '80',
  },
  {
    key: 'backups.staleAfterHours',
    group: 'backups',
    label: 'Backup considered stale after (hours)',
    help: 'How long without a successful backup before the Backups page raises a warning and emails the admins. Backups run nightly, so anything under 24 would alert on a normal schedule.',
    kind: 'number',
    fallback: '48',
  },
  {
    key: 'backups.restoreTestDays',
    group: 'backups',
    label: 'Restore drill overdue after (days)',
    help: 'How long since the last restore drill before the Backups page marks one as due. An untested backup is a guess; this is an advisory only and never emails.',
    kind: 'number',
    fallback: '90',
  },
];

/**
 * Read at boot, before the database is reachable, so they cannot live in it.
 * Shown read-only on /admin/config so an operator can see the whole picture
 * in one place instead of guessing which values are still environment-only.
 */
export const BOOTSTRAP_ENV_VARS = [
  { name: 'DATABASE_URL', help: 'Postgres connection string. Read before anything else can load.' },
  {
    name: 'AUTH_SECRET',
    help: 'Signs sessions, and derives the key that encrypts every secret stored below. Changing it makes saved secrets unreadable.',
  },
  {
    name: 'ENCRYPTION_KEY',
    help: 'Optional. Encrypts stored secrets independently of AUTH_SECRET, so sessions and secrets can be rotated separately.',
  },
  { name: 'NODE_ENV', help: 'development or production. Set by the runtime.' },
  { name: 'DATA_DIR', help: 'Writable directory for runtime state on this server.' },
  {
    name: 'SEED_ADMIN_EMAIL',
    help: 'Creates the first administrator on an empty database. Ignored once an administrator exists.',
  },
  {
    name: 'SEED_ADMIN_PASSWORD',
    help: 'Password for that first administrator. Change it after signing in.',
  },
  {
    name: 'NEXT_PUBLIC_APP_URL',
    help: 'Baked into the browser bundle at build time, so it cannot be read from the database.',
  },
  {
    name: 'NEXT_PUBLIC_WORKSPACE_NAME',
    help: 'Workspace name shown in the browser (the dashboard heading, email templates). Baked in at build time. Everything created server-side reads the Workspace name setting above instead.',
  },
] as const;

const BY_KEY = new Map(SETTINGS.map((entry) => [entry.key, entry]));

export function findSetting(key: string): SettingEntry | undefined {
  return BY_KEY.get(key);
}

export function settingsInGroup(group: SettingGroupId): SettingEntry[] {
  return SETTINGS.filter((entry) => entry.group === group);
}

export function isSecret(entry: SettingEntry) {
  return entry.kind === 'secret';
}
