// Application Configuration
//
// Only settings with a live reader belong here. The sandbox-era blocks (e2b,
// packages, files, api, dev) and the unused UI/code-application knobs were
// removed once nothing read them — a config file that is mostly inert reads
// as the application's policy surface while controlling nothing.

export const appConfig = {
  // AI Model Configuration
  ai: {
    // Default AI model. DeepSeek is the only provider and `deepseek-v4-flash`
    // is the reasoning default — every DeepSeek model reasons (they emit
    // `reasoning_content` and need the reasoning-SSE rewrite plus thinking
    // enabled in the request body).
    defaultModel: 'deepseek-v4-flash',

    // Available models. DeepSeek's current catalog (api-docs.deepseek.com):
    // the reasoning tiers offered in Admin → Configuration.
    // `deepseek-v4-flash-vision-exp` additionally accepts image input.
    availableModels: [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash-vision-exp',
    ],

    // Model display names
    modelDisplayNames: {
      'deepseek-v4-flash': 'DeepSeek V4 Flash',
      'deepseek-v4-pro': 'DeepSeek V4 Pro',
      'deepseek-v4-flash-vision-exp': 'DeepSeek V4 Flash Vision',
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
    // Automatic truncation recovery: re-asks the model for each file the reply cut off.
    // Detection runs regardless of this flag and is reported in chat and /admin/jobs;
    // recovery itself stays off until the fence-contract detector rewrite has been
    // reviewed against live output — the old "too many false positives" verdict predates
    // that rewrite, and enabling this also buys extra model calls per truncated file.
    enableTruncationRecovery: false,
  },

  // UI Configuration
  ui: {
    // Toast notification duration (milliseconds)
    toastDuration: 3000,
  },
};
