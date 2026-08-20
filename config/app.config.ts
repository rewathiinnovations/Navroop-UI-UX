// Application Configuration
//
// Only settings with a live reader belong here. The sandbox-era blocks (e2b,
// packages, files, api, dev) and the unused UI/code-application knobs were
// removed once nothing read them — a config file that is mostly inert reads
// as the application's policy surface while controlling nothing.

export const appConfig = {
  // AI Model Configuration
  ai: {
    // Default AI model. Restored to upstream's frontier default — the fork had
    // reverted this to 2.5-flash, which was the single clearest codegen regression.
    defaultModel: 'google/gemini-3-pro-preview',

    // Available models. Flash stays as the cheap option; the frontier tiers lead.
    availableModels: [
      'google/gemini-3-pro-preview',
      'anthropic/claude-opus-5',
      'anthropic/claude-sonnet-5',
      'openai/gpt-5',
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      'moonshotai/kimi-k2-instruct-0905',
    ],

    // Model display names
    modelDisplayNames: {
      'google/gemini-3-pro-preview': 'Gemini 3 Pro (Preview)',
      'anthropic/claude-opus-5': 'Claude Opus 5',
      'anthropic/claude-sonnet-5': 'Claude Sonnet 5',
      'openai/gpt-5': 'GPT-5',
      'google/gemini-2.5-pro': 'Gemini 2.5 Pro',
      'google/gemini-2.5-flash': 'Gemini 2.5 Flash',
      'moonshotai/kimi-k2-instruct-0905': 'Kimi K2 (Groq)',
    } as Record<string, string>,

    // Temperature settings for non-reasoning models
    defaultTemperature: 0.7,

    // Max output tokens for code generation. This is passed as `maxOutputTokens`
    // (AI SDK v5) and capped by the workspace plan's maxTokensPerJob. It was
    // previously sent under the v4 name `maxTokens`, which v5 ignores — so this
    // ceiling binds for the first time and must be generous enough for a
    // multi-file first build.
    //
    // 32000 was not. A five-page Next.js site stopped at exactly 32000 output
    // tokens: one component ended mid-identifier and four more that page.tsx
    // imported were never written, so the site was stored and could not
    // compile. A whole site has to fit in one reply, because there is no
    // continuation — DeepSeek V4 allows far more (384K), and the plan's
    // maxTokensPerJob (120K by default) still bounds this.
    maxTokens: 96000,

    // Max output tokens for truncation recovery (rewrites one full file).
    truncationRecoveryMaxTokens: 16000,
  },

  // Code Application Configuration
  codeApplication: {
    // Enable/disable automatic truncation recovery
    enableTruncationRecovery: false, // Disabled - too many false positives
  },

  // UI Configuration
  ui: {
    // Toast notification duration (milliseconds)
    toastDuration: 3000,
  },
};
