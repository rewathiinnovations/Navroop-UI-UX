/**
 * Resolves configuration with a single precedence rule: database, then
 * environment, then the registry fallback.
 *
 * Admin edits therefore take effect immediately, while a deployment that has
 * never opened /admin/config keeps running on the environment variables it
 * already has. Clearing a setting deletes the stored row, which hands the value
 * back to the environment rather than blanking it.
 *
 * Server-only: this reads Prisma. Client and edge modules must be passed the
 * resolved value instead of importing this.
 */
import { decrypt, encrypt } from '@/lib/crypto';
import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { last4FromSecret } from '@/lib/api-keys';
import {
  BOOTSTRAP_ENV_VARS,
  SETTINGS,
  SETTING_GROUPS,
  findSetting,
  isSecret,
  type SettingEntry,
} from './registry';

/** Namespaced so these rows never collide with the ad-hoc AppSetting keys. */
const KEY_PREFIX = 'setting:';

const CACHE_MS = 30_000;
const cache = new Map<string, { value: string | null; expiresAt: number }>();

export type SettingSource = 'db' | 'env' | 'fallback' | 'unset';

type StoredValue = {
  /** Ciphertext when the entry is a secret, plaintext otherwise. */
  value: string;
  encrypted: boolean;
  last4?: string | null;
};

function rowKey(key: string) {
  return `${KEY_PREFIX}${key}`;
}

function parseStored(raw: string | null | undefined): StoredValue | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredValue;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.value !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

type StoredRead = {
  value: string | null;
  /** A row exists but its ciphertext cannot be read — "not readable" is not "not set". */
  undecryptable: boolean;
};

function readStored(stored: StoredValue | null, key: string): StoredRead {
  if (!stored) return { value: null, undecryptable: false };
  if (!stored.encrypted) return { value: stored.value.trim() || null, undecryptable: false };
  try {
    return { value: decrypt(stored.value).trim() || null, undecryptable: false };
  } catch (error) {
    // A rotated ENCRYPTION_KEY makes old ciphertext unreadable. Fall through to
    // the environment rather than crashing the request — but loudly: a stored
    // secret silently reverting to env leaves downstream failures as the only
    // symptom (F-076). Key name only, never the value.
    log.error('settings.secret_undecryptable', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return { value: null, undecryptable: true };
  }
}

function envValue(entry: SettingEntry): string | null {
  const names = [entry.env, ...(entry.envAliases ?? [])].filter(Boolean) as string[];
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return null;
}

export function invalidateSettingsCache(key?: string) {
  if (key) cache.delete(key);
  else cache.clear();
}

/**
 * Resolved value for one setting, or null when nothing is configured anywhere.
 * Unknown keys return null rather than throwing — a typo should not take a
 * request down.
 */
export async function getSetting(key: string): Promise<string | null> {
  const entry = findSetting(key);
  if (!entry) return null;

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let stored: StoredValue | null = null;
  let readFailed = false;
  try {
    const row = await prisma.appSetting.findUnique({
      where: { key: rowKey(key) },
      select: { value: true },
    });
    stored = parseStored(row?.value);
  } catch (error) {
    // Database unreachable — the environment fallback is what keeps a
    // half-booted instance serving instead of erroring on every read. But a
    // value resolved from a failed read must not be pinned for 30 s: one blip
    // would silently switch credentials for every caller (F-075).
    readFailed = true;
    log.error('settings.db_read_failed', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    stored = null;
  }

  const value = readStored(stored, key).value ?? envValue(entry) ?? entry.fallback?.trim() ?? null;
  if (!readFailed) {
    cache.set(key, { value, expiresAt: Date.now() + CACHE_MS });
  }
  return value;
}

/** Batch form of `getSetting`, keyed by setting key. */
export async function getSettings<K extends string>(
  keys: readonly K[],
): Promise<Record<K, string | null>> {
  const out = {} as Record<K, string | null>;
  await Promise.all(
    keys.map(async (key) => {
      out[key] = await getSetting(key);
    }),
  );
  return out;
}

/** True when every listed setting resolves to a non-empty value. */
export async function hasSettings(keys: readonly string[]): Promise<boolean> {
  const values = await getSettings(keys);
  return keys.every((key) => Boolean(values[key]));
}

function sourceFor(entry: SettingEntry, read: StoredRead): SettingSource {
  if (read.value) return 'db';
  if (envValue(entry)) return 'env';
  if (entry.fallback?.trim()) return 'fallback';
  return 'unset';
}

export type DescribedSetting = {
  key: string;
  group: string;
  label: string;
  help: string;
  kind: SettingEntry['kind'];
  options?: SettingEntry['options'];
  placeholder?: string;
  envName: string | null;
  source: SettingSource;
  /** Plain value for non-secrets; null for secrets, which are never sent out. */
  value: string | null;
  /** Display-only hint for secrets, e.g. `••••••••cdef`. */
  masked: string | null;
  configured: boolean;
  /**
   * A stored value exists but cannot be decrypted (rotated ENCRYPTION_KEY).
   * Rendered as "re-enter this value", never as merely absent (F-076).
   */
  undecryptable: boolean;
};

/**
 * Everything /admin/config needs to render, with secrets reduced to a mask.
 * Secret plaintext never leaves the server.
 */
export async function describeSettings(): Promise<{
  groups: typeof SETTING_GROUPS;
  settings: DescribedSetting[];
  bootstrap: Array<{ name: string; help: string; present: boolean }>;
}> {
  let rows: Array<{ key: string; value: string }> = [];
  try {
    rows = await prisma.appSetting.findMany({
      where: { key: { startsWith: KEY_PREFIX } },
      select: { key: true, value: true },
    });
  } catch {
    rows = [];
  }
  const storedByKey = new Map(rows.map((row) => [row.key.slice(KEY_PREFIX.length), row.value]));

  const settings = SETTINGS.map((entry): DescribedSetting => {
    const stored = parseStored(storedByKey.get(entry.key));
    const read = readStored(stored, entry.key);
    const source = sourceFor(entry, read);
    const resolved = read.value ?? envValue(entry) ?? entry.fallback?.trim() ?? null;
    const secret = isSecret(entry);
    return {
      key: entry.key,
      group: entry.group,
      label: entry.label,
      help: entry.help,
      kind: entry.kind,
      options: entry.options,
      placeholder: entry.placeholder,
      envName: entry.env ?? null,
      source,
      value: secret ? null : resolved,
      masked: secret && resolved ? `••••••••${last4FromSecret(resolved)}` : null,
      configured: Boolean(resolved),
      undecryptable: read.undecryptable,
    };
  });

  return {
    groups: SETTING_GROUPS,
    settings,
    bootstrap: BOOTSTRAP_ENV_VARS.map((row) => ({
      name: row.name,
      help: row.help,
      present: Boolean(String(process.env[row.name] || '').trim()),
    })),
  };
}

export type SaveSettingInput = {
  key: string;
  /** Empty or whitespace clears the stored row and restores the env fallback. */
  value: string;
};

export type SaveActor = { id: string; email: string };

/**
 * Writes settings and records one audit entry per changed key. Secret values
 * are encrypted with the same AES-256-GCM helper the Integration table uses.
 */
export async function saveSettings(inputs: SaveSettingInput[], actor: SaveActor) {
  const { writeAudit } = await import('@/lib/audit/log');
  const applied: string[] = [];
  const unknown: string[] = [];

  for (const input of inputs) {
    const entry = findSetting(input.key);
    if (!entry) {
      unknown.push(input.key);
      continue;
    }

    const trimmed = input.value.trim();
    const before = await getSetting(input.key);

    if (!trimmed) {
      await prisma.appSetting.deleteMany({ where: { key: rowKey(entry.key) } });
    } else {
      const secret = isSecret(entry);
      const payload: StoredValue = secret
        ? { value: encrypt(trimmed), encrypted: true, last4: last4FromSecret(trimmed) }
        : { value: trimmed, encrypted: false };
      const serialized = JSON.stringify(payload);
      await prisma.appSetting.upsert({
        where: { key: rowKey(entry.key) },
        create: { key: rowKey(entry.key), value: serialized },
        update: { value: serialized },
      });
    }

    invalidateSettingsCache(entry.key);
    applied.push(entry.key);

    const changed = before !== (trimmed || null);
    if (changed) {
      await writeAudit({
        actorId: actor.id,
        actorEmail: actor.email,
        action: trimmed ? 'setting.update' : 'setting.clear',
        targetType: 'setting',
        targetId: entry.key,
        // Never audit the value itself — only that it changed, and to what state.
        after: { key: entry.key, configured: Boolean(trimmed), secret: isSecret(entry) },
      });
    }
  }

  return { applied, unknown };
}

export async function clearSetting(key: string, actor: SaveActor) {
  return saveSettings([{ key, value: '' }], actor);
}
