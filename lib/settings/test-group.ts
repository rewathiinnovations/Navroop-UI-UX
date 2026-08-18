/**
 * Per-group checks behind the Test button on /admin/config.
 *
 * Two kinds of result, and the difference is stated in the message rather than
 * blurred: a `live` check actually called the service with the saved
 * credential, a `local` check only confirmed the values are present and
 * well-formed. Reporting a presence check as if it proved the key works is how
 * an operator ends up debugging a broken key in production.
 */
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

async function testAi(): Promise<GroupTestResult['checks']> {
  const checks: GroupTestResult['checks'] = [];

  const anthropic = await getSetting('ai.anthropic.apiKey');
  if (anthropic) {
    const base = (await getSetting('ai.anthropic.baseUrl')) || 'https://api.anthropic.com';
    checks.push({
      label: 'Anthropic',
      ...(await probe(`${base.replace(/\/+$/, '')}/v1/models`, {
        'x-api-key': anthropic,
        'anthropic-version': '2023-06-01',
      })),
    });
  }

  const openai = await getSetting('ai.openai.apiKey');
  if (openai) {
    const base = (await getSetting('ai.openai.baseUrl')) || 'https://api.openai.com/v1';
    checks.push({
      label: 'OpenAI',
      ...(await probe(`${base.replace(/\/+$/, '')}/models`, {
        authorization: `Bearer ${openai}`,
      })),
    });
  }

  const groq = await getSetting('ai.groq.apiKey');
  if (groq) {
    const base = (await getSetting('ai.groq.baseUrl')) || 'https://api.groq.com/openai/v1';
    checks.push({
      label: 'Groq',
      ...(await probe(`${base.replace(/\/+$/, '')}/models`, {
        authorization: `Bearer ${groq}`,
      })),
    });
  }

  const google = await getSetting('ai.google.apiKey');
  if (google) {
    const base =
      (await getSetting('ai.google.baseUrl')) || 'https://generativelanguage.googleapis.com';
    checks.push({
      label: 'Google Gemini',
      ...(await probe(`${base.replace(/\/+$/, '')}/v1beta/models`, {
        'x-goog-api-key': google,
      })),
    });
  }

  const gateway = await getSetting('ai.gateway.apiKey');
  if (gateway) {
    checks.push({ label: 'AI Gateway', ...present(gateway, 'AI Gateway key') });
  }

  if (checks.length === 0) {
    checks.push({
      label: 'Providers',
      ok: false,
      depth: 'local',
      message: 'No AI provider key is set. Generation cannot run until at least one is configured.',
    });
  }

  return checks;
}

async function testTooling(): Promise<GroupTestResult['checks']> {
  const values = await getSettings([
    'tooling.firecrawl.apiKey',
    'tooling.e2b.apiKey',
    'tooling.morph.apiKey',
    'tooling.unsplash.accessKey',
  ]);
  return [
    { label: 'Firecrawl', ...present(values['tooling.firecrawl.apiKey'], 'Firecrawl key') },
    { label: 'E2B', ...present(values['tooling.e2b.apiKey'], 'E2B key') },
    { label: 'Morph', ...present(values['tooling.morph.apiKey'], 'Morph key') },
    { label: 'Unsplash', ...present(values['tooling.unsplash.accessKey'], 'Unsplash key') },
  ];
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

async function testApp(): Promise<GroupTestResult['checks']> {
  const values = await getSettings(['app.url', 'app.cronSecret']);
  return [
    { label: 'Application URL', ...validUrl(values['app.url'], 'Application URL') },
    {
      label: 'Scheduled tasks',
      ok: true,
      depth: 'local',
      message: values['app.cronSecret']
        ? 'A secret is set, so an external scheduler can trigger nightly jobs.'
        : 'No secret set. Nightly jobs cannot be triggered from outside this server.',
    },
  ];
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
