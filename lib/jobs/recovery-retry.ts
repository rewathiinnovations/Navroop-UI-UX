import { resolveImportMode, type ImportMode } from '../import/mode';
import { normalizeSourceUrl } from '../import/url';
import { offersRecoveryRetry, recoveryNextStepLine } from './copy';

export type RecoveryRetryIntent =
  | { action: 'import'; sourceUrl: string; mode: ImportMode }
  | { action: 'plan'; prompt: string }
  | { action: 'build'; prompt: string }
  | { action: 'none'; nextStep: string };

export function resolvePlanRetryPrompt(input: { inputPrompt?: string | null }): string | null {
  const prompt = String(input.inputPrompt || '').trim();
  return prompt || null;
}

export function resolveImportRetrySource(input: {
  sourceUrl?: string | null;
  importMode?: string | null;
  inputPrompt?: string | null;
}): { sourceUrl: string; mode: ImportMode } | null {
  const sourceUrl = normalizeSourceUrl(String(input.sourceUrl || input.inputPrompt || ''));
  if (!sourceUrl) return null;
  return { sourceUrl, mode: resolveImportMode(input.importMode) };
}

export function recoveryRetryIntent(input: {
  kind?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  sourceUrl?: string | null;
  importMode?: string | null;
  inputPrompt?: string | null;
}): RecoveryRetryIntent {
  if (!offersRecoveryRetry(input)) {
    return { action: 'none', nextStep: recoveryNextStepLine(input) };
  }
  if (input.kind === 'IMPORT') {
    const source = resolveImportRetrySource(input);
    if (!source) {
      return {
        action: 'none',
        nextStep: 'We do not have the source URL for this import. Paste the page content instead.',
      };
    }
    return { action: 'import', sourceUrl: source.sourceUrl, mode: source.mode };
  }
  if (input.kind === 'PLAN') {
    const prompt = resolvePlanRetryPrompt(input);
    if (!prompt) {
      return {
        action: 'none',
        nextStep: 'We do not have the prompt for this plan. Type a new description to plan again.',
      };
    }
    return { action: 'plan', prompt };
  }
  return { action: 'build', prompt: input.inputPrompt || '' };
}

export async function dispatchRecoveryRetry(
  intent: RecoveryRetryIntent,
  deps: {
    startImport: (source: { sourceUrl: string; mode: ImportMode }) => Promise<void>;
    startPlan: (prompt: string) => Promise<void>;
    startBuild: (prompt: string) => Promise<void>;
    createRetryJob: () => Promise<{ ok: boolean; prompt?: string; error?: string }>;
  },
) {
  if (intent.action === 'none') return;
  if (intent.action === 'import') {
    await deps.startImport({ sourceUrl: intent.sourceUrl, mode: intent.mode });
    return;
  }
  if (intent.action === 'plan') {
    await deps.startPlan(intent.prompt);
    return;
  }
  const result = await deps.createRetryJob();
  if (!result.ok) return;
  if (result.prompt) await deps.startBuild(result.prompt);
}
