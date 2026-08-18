// Application Configuration
// This file contains all configurable settings for the application

export const appConfig = {
  // E2B Sandbox Configuration
  e2b: {
    // Sandbox timeout in minutes
    timeoutMinutes: 30,

    // Convert to milliseconds for E2B API
    get timeoutMs() {
      return this.timeoutMinutes * 60 * 1000;
    },

    // Development server port (E2B uses 5173 for Vite)
    vitePort: 5173,

    // Time to wait for Vite dev server to be ready (in milliseconds)
    viteStartupDelay: 10000,

    // Working directory in sandbox
    workingDirectory: '/home/user/app',
  },

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

    // Model API configuration
    modelApiConfig: {
      'moonshotai/kimi-k2-instruct-0905': {
        provider: 'groq',
        model: 'moonshotai/kimi-k2-instruct-0905',
      },
    },

    // Temperature settings for non-reasoning models
    defaultTemperature: 0.7,

    // Max output tokens for code generation. This is passed as `maxOutputTokens`
    // (AI SDK v5) and capped by the workspace plan's maxTokensPerJob. It was
    // previously sent under the v4 name `maxTokens`, which v5 ignores — so this
    // ceiling binds for the first time and must be generous enough for a
    // multi-file first build.
    maxTokens: 32000,

    // Max output tokens for truncation recovery (rewrites one full file).
    truncationRecoveryMaxTokens: 16000,
  },

  // Code Application Configuration
  codeApplication: {
    // Delay after applying code before refreshing iframe (milliseconds)
    defaultRefreshDelay: 2000,

    // Delay when packages are installed (milliseconds)
    packageInstallRefreshDelay: 5000,

    // Enable/disable automatic truncation recovery
    enableTruncationRecovery: false, // Disabled - too many false positives

    // Maximum number of truncation recovery attempts per file
    maxTruncationRecoveryAttempts: 1,
  },

  // UI Configuration
  ui: {
    // Show/hide certain UI elements
    showModelSelector: true,
    showStatusIndicator: true,

    // Animation durations (milliseconds)
    animationDuration: 200,

    // Toast notification duration (milliseconds)
    toastDuration: 3000,

    // Maximum chat messages to keep in memory
    maxChatMessages: 100,

    // Maximum recent messages to send as context
    maxRecentMessagesContext: 20,
  },

  // Development Configuration
  dev: {
    // Enable debug logging
    enableDebugLogging: true,

    // Enable performance monitoring
    enablePerformanceMonitoring: false,

    // Log API responses
    logApiResponses: true,
  },

  // Package Installation Configuration
  packages: {
    // Use --legacy-peer-deps flag for npm install
    useLegacyPeerDeps: true,

    // Package installation timeout (milliseconds)
    installTimeout: 60000,

    // Auto-restart Vite after package installation
    autoRestartVite: true,
  },

  // File Management Configuration
  files: {
    // Excluded file patterns (files to ignore)
    excludePatterns: [
      'node_modules/**',
      '.git/**',
      '.next/**',
      'dist/**',
      'build/**',
      '*.log',
      '.DS_Store',
    ],

    // Maximum file size to read (bytes)
    maxFileSize: 1024 * 1024, // 1MB

    // File extensions to treat as text
    textFileExtensions: [
      '.js',
      '.jsx',
      '.ts',
      '.tsx',
      '.css',
      '.scss',
      '.sass',
      '.html',
      '.xml',
      '.svg',
      '.json',
      '.yml',
      '.yaml',
      '.md',
      '.txt',
      '.env',
      '.gitignore',
      '.dockerignore',
    ],
  },

  // API Endpoints Configuration (for external services)
  api: {
    // Retry configuration
    maxRetries: 3,
    retryDelay: 1000, // milliseconds

    // Request timeout (milliseconds)
    requestTimeout: 30000,
  },
};

// Type-safe config getter
export function getConfig<K extends keyof typeof appConfig>(key: K): (typeof appConfig)[K] {
  return appConfig[key];
}

// Helper to get nested config values
export function getConfigValue(path: string): any {
  return path.split('.').reduce((obj, key) => obj?.[key], appConfig as any);
}

export default appConfig;
