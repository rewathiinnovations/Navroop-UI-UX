import { appConfig } from '@/config/app.config';

/**
 * DeepSeek's thinking-mode (`-pro`) models reject a `temperature`, so the option has to be
 * omitted rather than set for them.
 *
 * That rule was stated in one place and violated in another. The main stream call guarded
 * it (`if (!actualModel.includes('-pro'))`); the truncation-recovery call decided with
 * `recoveryEntry.model.startsWith('gpt-5') ? undefined : defaultTemperature` — a dead
 * OpenAI test that can never be true for a DeepSeek id, so `deepseek-v4-pro` received a
 * temperature and every recovery call on the stronger model was rejected by the provider.
 * The run then reported the truncated files as kept and named a provider failure, i.e.
 * truncation recovery was entirely non-functional on that model and the user was told it
 * was the vendor's fault. One decision, used by every call site (F-041).
 */
export function temperatureForModel(model: string): number | undefined {
  return model.includes('-pro') ? undefined : appConfig.ai.defaultTemperature;
}
