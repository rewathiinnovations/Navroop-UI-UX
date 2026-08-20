/**
 * Per-group checks behind the Test button on /admin/config.
 *
 * Two kinds of result, and the difference is stated in the message rather than
 * blurred: a `live` check actually called the service with the saved
 * credential, a `local` check only confirmed the values are present and
 * well-formed. Reporting a presence check as if it proved the key works is how
 * an operator ends up debugging a broken key in production.
 */
import { DEEPSEEK_DEFAULT_BASE_URL } from '@/lib/ai/providers';
import { loadEffectiveProviderEnv } from '@/lib/ai/effective-env';
import { getSetting, getSettings } from './resolve';
import type { SettingGroupId } from './registry';

export type CheckResult = {
  ok: boolean;
  /** `live` reached the provider; `local` only validated what is stored. */
  depth: 'live' | 'local';
  message: string;
};

export type GroupTestResult = {
  group: SettingGroupId;
  ok: boolean;
  checks: Array<{ label: string } & CheckResult>;
};

const TIMEOUT_MS = 8000;

async function probe(url: string, headers: Record<string, string>): Promise<CheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (response.ok) {
      return { ok: true, depth: 'live', message: 'Key accepted.' };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        depth: 'live',
        message: `Rejected by the provider (${response.status}). The key is wrong, revoked, or lacks access.`,
      };
    }
    return {
      ok: false,
      depth: 'live',
      message: `Provider replied ${response.status}. The key may be fine — try again shortly.`,
    };
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === 'AbortError';
    return {
      ok: false,
      depth: 'live',
      message: aborted
        ? 'Timed out reaching the provider. Check outbound network access from this server.'
        : `Could not reach the provider: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function present(value: string | null, label: string): CheckResult {
  return value
    ? { ok: true, depth: 'local', message: `${label} is set. Not verified against the service.` }
    : { ok: false, depth: 'local', message: `${label} is not set.` };
}

function validUrl(value: string | null, label: string): CheckResult {
  if (!value) return { ok: false, depth: 'local', message: `${label} is not set.` };
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        ok: false,
        depth: 'local',
        message: `${label} must start with http:// or https://.`,
      };
    }
    return { ok: true, depth: 'local', message: `${label} is a valid URL.` };
  } catch {
    return { ok: false, depth: 'local', message: `${label} is not a valid URL.` };
  }
}

async function testConnectors(): Promise<GroupTestResult['checks']> {
  const values = await getSettings([
    'github.oauth.clientId',
    'github.oauth.clientSecret',
    'github.oauth.callbackUrl',
  ]);
  const checks: GroupTestResult['checks'] = [
    { label: 'Client ID', ...present(values['github.oauth.clientId'], 'Client ID') },
    { label: 'Client secret', ...present(values['github.oauth.clientSecret'], 'Client secret') },
    { label: 'Callback URL', ...validUrl(values['github.oauth.callbackUrl'], 'Callback URL') },
  ];

  const callback = values['github.oauth.callbackUrl'];
  if (callback) {
    const expectedPath = '/api/github/callback';
    let pathOk = false;
    try {
      pathOk = new URL(callback).pathname === expectedPath;
    } catch {
      pathOk = false;
    }
    checks.push({
      label: 'Callback path',
      ok: pathOk,
      depth: 'local',
      message: pathOk
        ? `Callback ends in ${expectedPath}, which is what this app serves.`
        : `Callback should end in ${expectedPath}. GitHub will redirect somewhere this app does not handle.`,
    });
  }

  return checks;
}

/**
 * DeepSeek is the only provider in the registry. This used to probe
 * `ai.anthropic.apiKey`, `ai.openai.apiKey`, `ai.groq.apiKey`,
 * `ai.google.apiKey` and `ai.gateway.apiKey` — every one of them deleted from
 * SETTINGS, and `getSetting` answers null for an unknown key rather than
 * throwing, so all five branches were skipped and the "no provider" fallback
 * fired on installs where generation was working. The one diagnostic for the
 * most important credential in the product reported a permanent false
 * negative.
 *
 * It then probed `getSetting('ai.deepseek.apiKey')` alone, which cannot see
 * the org/personal `ApiKey` tiers above it — green on a key generation never
 * uses, red on one it does (F-074). It now resolves through the same
 * `loadEffectiveProviderEnv` overlay `clientForEntry` consumes, and names the
 * tier the credential came from so an unexpected source is visible rather
 * than merely effective.
 */
async function testAi(): Promise<GroupTestResult['checks']> {
  const env = await loadEffectiveProviderEnv(null, process.env);
  const key = env.DEEPSEEK_API_KEY?.trim() || null;
  if (!key) {
    return [
      {
        label: 'DeepSeek',
        ok: false,
        depth: 'local',
        message:
          'No AI provider key is set. Generation cannot run until at least one is configured.',
      },
    ];
  }

  // `getSetting` merges the DB row with its DEEPSEEK_API_KEY environment
  // fallback, so equality means "the tier /admin/config already renders a
  // source badge for". Inequality means a stored ApiKey/OrgApiKey row is
  // overriding this page — the invisible tier F-074 is about. (Deliberately no
  // direct process.env read: resolution stays on the one key path.)
  const settingTier = await getSetting('ai.deepseek.apiKey');
  const source =
    key === settingTier
      ? 'Admin → Configuration or its DEEPSEEK_API_KEY environment fallback (the badge above shows which)'
      : 'a stored workspace API key row — it overrides Admin → Configuration; remove it under Settings → API keys if that is unexpected';

  // Only the credential is checked: `ai.primaryModel` resolves to a registry
  // fallback and could never report anything but "set".
  const base = (env.DEEPSEEK_BASE_URL?.trim() || DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const probed = await probe(`${base}/models`, { authorization: `Bearer ${key}` });
  return [{ label: 'DeepSeek', ...probed, message: `${probed.message} Key source: ${source}.` }];
}

/**
 * Both remaining keys are dialled with the credential and header scheme their
 * consumer uses — `lib/import/firecrawl.ts` and `lib/assets/stock-photo.ts` —
 * so a green line means the saved value was accepted, not merely typed in.
 *
 * There used to be an E2B line here, and a Morph one. Both read entries that
 * are now gone from SETTINGS: the sandbox subsystem was deleted, and Morph Fast
 * Apply had no applier, so until it was removed the button confirmed a billable
 * credential nothing would ever read.
 */
async function testTooling(): Promise<GroupTestResult['checks']> {
  const values = await getSettings(['tooling.firecrawl.apiKey', 'tooling.unsplash.accessKey']);
  const checks: GroupTestResult['checks'] = [];

  const firecrawl = values['tooling.firecrawl.apiKey'];
  checks.push({
    label: 'Firecrawl',
    ...(firecrawl
      ? await probe('https://api.firecrawl.dev/v1/team/credit-usage', {
          authorization: `Bearer ${firecrawl}`,
        })
      : {
          ok: false,
          depth: 'local' as const,
          message: 'Firecrawl key is not set. Importing an existing website by URL will fail.',
        }),
  });

  const unsplash = values['tooling.unsplash.accessKey'];
  checks.push({
    label: 'Unsplash',
    ...(unsplash
      ? await probe('https://api.unsplash.com/photos?per_page=1', {
          authorization: `Client-ID ${unsplash}`,
        })
      : {
          ok: true,
          depth: 'local' as const,
          message:
            'No access key. Generated sites use placeholder imagery, which is a supported setup.',
        }),
  });

  return checks;
}

async function testEmail(): Promise<GroupTestResult['checks']> {
  const values = await getSettings(['email.resend.apiKey', 'email.from']);
  const from = values['email.from'];
  return [
    { label: 'API key', ...present(values['email.resend.apiKey'], 'Resend key') },
    {
      label: 'From address',
      ok: Boolean(from && /.+@.+\..+/.test(from)),
      depth: 'local',
      message: from
        ? /.+@.+\..+/.test(from)
          ? 'From address looks well-formed. Its domain must also be verified with your email provider.'
          : 'From address does not contain a valid email address.'
        : 'From address is not set.',
    },
  ];
}

async function testStorage(): Promise<GroupTestResult['checks']> {
  const driver = (await getSetting('storage.driver')) || 'local';
  if (driver === 's3') {
    const values = await getSettings(['storage.s3.region', 'storage.s3.publicUrl']);
    return [
      { label: 'Driver', ok: true, depth: 'local', message: 'Using S3-compatible storage.' },
      { label: 'Region', ...present(values['storage.s3.region'], 'S3 region') },
      { label: 'Public URL', ...validUrl(values['storage.s3.publicUrl'], 'S3 public URL') },
    ];
  }
  const dir = await getSetting('storage.localDir');
  return [
    { label: 'Driver', ok: true, depth: 'local', message: 'Using local disk.' },
    {
      label: 'Directory',
      ok: true,
      depth: 'local',
      message: dir
        ? `Files are written to ${dir}. Make sure it is on a persistent volume.`
        : 'Using the default directory. Make sure it is on a persistent volume.',
    },
  ];
}

async function testBackups(): Promise<GroupTestResult['checks']> {
  const values = await getSettings([
    'backups.bucket',
    'backups.region',
    'backups.endpoint',
    'backups.localDir',
  ]);
  if (values['backups.localDir'] && !values['backups.bucket']) {
    return [
      {
        label: 'Destination',
        ok: true,
        depth: 'local',
        message: `Backups go to ${values['backups.localDir']} on this server. That is fine for development, but a backup on the same disk as the database will not survive losing that disk.`,
      },
    ];
  }
  return [
    { label: 'Bucket', ...present(values['backups.bucket'], 'Backup bucket') },
    { label: 'Region', ...present(values['backups.region'], 'Backup region') },
    {
      label: 'Endpoint',
      ok: true,
      depth: 'local',
      message: values['backups.endpoint']
        ? `Using endpoint ${values['backups.endpoint']}.`
        : 'No endpoint set — AWS S3 will be used.',
    },
  ];
}

/**
 * The health endpoint of the configured address, and the answer has to look
 * like this app's own health report.
 *
 * A wrong Application URL is invisible from the server: password-reset links
 * and the GitHub App callback are built from it, both land somewhere else, and
 * the only symptom reaches us as "the reset email is broken". Parsing the URL
 * would call every one of those installs healthy.
 */
async function probeSelf(url: string): Promise<CheckResult> {
  const target = `${url.replace(/\/+$/, '')}/api/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(target, { redirect: 'manual', signal: controller.signal });
    const body = (await response.json().catch(() => null)) as {
      checks?: Record<string, unknown>;
    } | null;
    if (!body || typeof body.checks?.db !== 'string') {
      return {
        ok: false,
        depth: 'live',
        message: `${target} answered ${response.status}, but not with this installation's health report. The address points at something else.`,
      };
    }
    return {
      ok: true,
      depth: 'live',
      message:
        response.status === 200
          ? 'This installation answered at that address.'
          : `This installation answered at that address and reports itself unhealthy (${response.status}). The address is right — see /admin/health for the failing check.`,
    };
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === 'AbortError';
    return {
      ok: false,
      depth: 'live',
      message: aborted
        ? `Timed out reaching ${target}. Either the address is wrong or this server cannot route back to its own public name.`
        : `Could not reach ${target}: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function testApp(): Promise<GroupTestResult['checks']> {
  const values = await getSettings(['app.url', 'app.cronSecret']);
  const url = values['app.url'];
  const format = validUrl(url, 'Application URL');
  const checks: GroupTestResult['checks'] = [{ label: 'Application URL', ...format }];
  if (url && format.ok) {
    checks.push({ label: 'Reachable', ...(await probeSelf(url)) });
  }
  checks.push({
    label: 'Scheduled tasks',
    ok: true,
    depth: 'local',
    message: values['app.cronSecret']
      ? 'A secret is set, so an external scheduler can trigger nightly jobs.'
      : 'No secret set. Nightly jobs cannot be triggered from outside this server.',
  });
  return checks;
}

const RUNNERS: Record<SettingGroupId, () => Promise<GroupTestResult['checks']>> = {
  connectors: testConnectors,
  ai: testAi,
  tooling: testTooling,
  email: testEmail,
  storage: testStorage,
  backups: testBackups,
  app: testApp,
};

export async function testSettingGroup(group: SettingGroupId): Promise<GroupTestResult> {
  const runner = RUNNERS[group];
  if (!runner) {
    return {
      group,
      ok: false,
      checks: [{ label: 'Group', ok: false, depth: 'local', message: 'Unknown group.' }],
    };
  }
  const checks = await runner();
  return { group, ok: checks.every((check) => check.ok), checks };
}
