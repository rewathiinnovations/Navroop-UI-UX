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
    key: 'tooling.morph.apiKey',
    group: 'tooling',
    label: 'Morph API key',
    help: 'Not in use. Nothing applies Morph edit blocks today, so a key here changes nothing — saving one used to make every follow-up edit report success and leave the files untouched.',
    kind: 'secret',
    env: 'MORPH_API_KEY',
  },
  {
    key: 'tooling.unsplash.accessKey',
    group: 'tooling',
    label: 'Unsplash access key',
    help: 'Optional. Supplies stock photography to generated sites; placeholders are used without it.',
    kind: 'secret',
    env: 'UNSPLASH_ACCESS_KEY',
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
    key: 'app.cronSecret',
    group: 'app',
    label: 'Scheduled-task secret',
    help: 'Shared secret an external scheduler must present to trigger nightly jobs. Leave blank to disable remote triggering.',
    kind: 'secret',
    env: 'CRON_SECRET',
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
    key: 'app.purgeDeletedDays',
    group: 'app',
    label: 'Deleted project retention (days)',
    help: 'How long a deleted project can still be restored before it is purged for good.',
    kind: 'number',
    env: 'PURGE_DELETED_DAYS',
    fallback: '30',
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
    help: 'Workspace name shown in the browser. Baked in at build time.',
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
