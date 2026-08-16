export const API_KEY_PROVIDERS = [
  { id: 'firecrawl', label: 'Firecrawl', env: 'FIRECRAWL_API_KEY' },
  { id: 'e2b', label: 'E2B', env: 'E2B_API_KEY' },
  { id: 'openai', label: 'OpenAI', env: 'OPENAI_API_KEY' },
  { id: 'anthropic', label: 'Anthropic', env: 'ANTHROPIC_API_KEY' },
  { id: 'google', label: 'Google Gemini', env: 'GEMINI_API_KEY' },
  { id: 'groq', label: 'Groq', env: 'GROQ_API_KEY' },
  { id: 'gateway', label: 'Vercel AI Gateway', env: 'AI_GATEWAY_API_KEY' },
] as const;

export const SETTINGS_API_KEY_PROVIDERS = [
  { id: 'firecrawl', label: 'Firecrawl' },
  { id: 'e2b', label: 'E2B' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'groq', label: 'Groq' },
] as const;

export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number]['id'];
export type SettingsApiKeyProvider = (typeof SETTINGS_API_KEY_PROVIDERS)[number]['id'];

export function maskSecret(value?: string | null) {
  if (!value) return { configured: false, masked: '' };
  const last4 = value.slice(-4);
  return { configured: true, masked: `••••••••${last4}`, last4 };
}

export function last4FromSecret(value: string) {
  return value.slice(-4);
}
