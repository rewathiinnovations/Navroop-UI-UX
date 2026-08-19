import { describe, expect, it } from 'vitest';
import { settingKeyForProvider } from '@/lib/api-keys';
import { OVERLAY_KEYS } from '@/lib/ai/effective-env';
import { SETTINGS } from '@/lib/settings/registry';

/**
 * A key saved in Admin → Configuration has to reach generation.
 *
 * It travels: setting row → getEffectiveApiKey → the provider-env overlay →
 * hasUsableCredential. That chain is joined by a name lookup, and `deepseek`
 * was missing from it — so the key saved fine, `getSetting` read it back, and
 * generation still answered "DeepSeek is not configured — add an API key in
 * Admin → Configuration", pointing the admin at the page they had just used.
 * Nothing in the chain errors when a link is missing; it just returns null.
 */

describe('provider keys saved in admin config are readable', () => {
  it('maps every overlaid provider to a setting that exists', () => {
    expect(OVERLAY_KEYS.length).toBeGreaterThan(0);
    for (const row of OVERLAY_KEYS) {
      const settingKey = settingKeyForProvider(row.provider);
      expect(settingKey, `${row.provider} has no setting key`).toBeTruthy();
      const entry = SETTINGS.find((setting) => setting.key === settingKey);
      expect(entry, `${settingKey} is not in the settings registry`).toBeTruthy();
      // The registry entry must fill the same env var the overlay writes.
      expect(entry?.env).toBe(row.env);
    }
  });
});
