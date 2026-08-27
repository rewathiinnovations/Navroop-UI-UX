/**
 * Answers one question: does the model this deployment actually serves accept
 * tool calls?
 *
 * It resolves the provider exactly as generation does — the effective-env
 * overlay, then the provider chain, then the chat-completions model — so a
 * verdict here is about the configured deployment and not about DeepSeek in
 * general.
 *
 *   node ./node_modules/tsx/dist/cli.mjs scripts/probe-tool-support.ts
 *   node ./node_modules/tsx/dist/cli.mjs scripts/probe-tool-support.ts --thinking=enabled
 *   node ./node_modules/tsx/dist/cli.mjs scripts/probe-tool-support.ts --model=deepseek-v4-pro
 *
 * BOTH `toolChoice` modes are probed and both verdicts are printed, and that is
 * the whole point of the script rather than a detail of it. An
 * OpenAI-compatible endpoint commonly accepts tools while rejecting
 * `tool_choice: "required"`, and DeepSeek is one: with thinking enabled
 * `required` comes back as "Thinking mode does not support this tool_choice",
 * which `classifyProviderFailure` reads as `malformed` — so it would not even
 * fail over. Probing only `required` would therefore record
 * `TOOLS: unsupported` for a deployment whose tools work perfectly, and send
 * the whole tool surface into the inert contingency for no reason.
 *
 * Generation sends `'auto'`, so `auto` is the verdict that decides the gate
 * (`MODEL_SUPPORTS_TOOLS` in lib/ai/providers.ts). The `required` line is
 * recorded so nobody later "simplifies" generation to `required` and is
 * surprised.
 *
 * `--thinking` is the only way to probe the other reasoning mode: `.env.local`
 * is loaded with `override: true`, so a `DEEPSEEK_THINKING` set in the
 * invocation env is discarded before this script reads anything, and the admin
 * setting outranks the environment in `loadEffectiveProviderEnv` regardless.
 * With no flag the mode is whatever this deployment is configured for.
 *
 * Measured 2026-08-25, all three models in `DEEPSEEK_MODELS`:
 *   thinking=enabled   auto supported / required REJECTED
 *   thinking=disabled  auto supported / required supported
 */
import { config } from 'dotenv';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { loadEffectiveProviderEnv } from '../lib/ai/effective-env';
import { loadProviderChain } from '../lib/ai/providers';
import { chatModelForEntry, thinkingEnabledFromEnv } from '../lib/ai/client-for-entry';
import { classifyProviderFailure } from '../lib/ai/failover';
import { isToolCallValidationError } from '../lib/ai/tool-validation';
import { prisma } from '../lib/db';

config({ path: '.env' });
config({ path: '.env.local', override: true });

/** `--flag=value`, or undefined when the flag is absent. */
function flagValue(argv: readonly string[], name: string): string | undefined {
  const flag = argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (!flag) return undefined;
  return flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : '';
}

/** `--thinking=enabled|disabled`, or undefined to use the configured mode. */
function thinkingOverride(argv: readonly string[]): 'enabled' | 'disabled' | undefined {
  const value = flagValue(argv, 'thinking');
  if (value === undefined) return undefined;
  if (value === '' || value === 'enabled') return 'enabled';
  if (value === 'disabled') return 'disabled';
  throw new Error(`--thinking must be "enabled" or "disabled", got "${value}"`);
}

/** One `generateText` with one trivial tool, reported per `toolChoice`. */
async function probe(
  model: Parameters<typeof generateText>[0]['model'],
  toolChoice: 'required' | 'auto',
): Promise<{ supported: boolean; detail: string }> {
  try {
    const result = await generateText({
      model,
      prompt: 'Call the ping tool with the note "probe".',
      tools: {
        ping: tool({
          description: 'Reply with pong.',
          inputSchema: z.object({ note: z.string() }),
          execute: async ({ note }) => `pong:${note}`,
        }),
      },
      toolChoice,
      stopWhen: stepCountIs(2),
    });
    const calls = result.steps.flatMap((step) => step.toolCalls);
    if (calls.length === 0) {
      return { supported: false, detail: 'accepted, but no tool call came back' };
    }
    return { supported: true, detail: `called ${calls.map((call) => call.toolName).join(', ')}` };
  } catch (error) {
    const detail = [
      `classification=${classifyProviderFailure(error)}`,
      `toolCallValidationError=${isToolCallValidationError(error)}`,
      error instanceof Error ? error.message : String(error),
    ].join(' ');
    return { supported: false, detail };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const override = thinkingOverride(argv);
  const requestedModel = flagValue(argv, 'model') || undefined;
  // A CLI invocation has no user, so this is the admin/env overlay only — the
  // same resolution a cron-driven generation would get.
  const resolved = await loadEffectiveProviderEnv(null);
  const providerEnv = override ? { ...resolved, DEEPSEEK_THINKING: override } : resolved;
  const chain = loadProviderChain(providerEnv, { requestedModel });
  const entry = chain[0];
  if (!entry) {
    console.log('MODEL: none');
    console.log('THINKING: unknown');
    console.log('TOOLS: unsupported');
    console.log('REASON: no provider is configured (no DeepSeek API key)');
    return;
  }

  console.log(`MODEL: ${entry.model}`);
  console.log(`THINKING: ${thinkingEnabledFromEnv(providerEnv) ? 'enabled' : 'disabled'}`);

  const model = chatModelForEntry(entry, providerEnv, entry.model);
  const auto = await probe(model, 'auto');
  const required = await probe(model, 'required');
  console.log(`TOOL_CHOICE_AUTO: ${auto.supported ? 'supported' : 'unsupported'} - ${auto.detail}`);
  console.log(
    `TOOL_CHOICE_REQUIRED: ${required.supported ? 'supported' : 'unsupported'} - ${required.detail}`,
  );
  // Generation uses `auto`, so that is the verdict that decides the gate. A
  // `required`-only rejection must never read as "tools do not work here".
  console.log(`TOOLS: ${auto.supported ? 'supported' : 'unsupported'}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
