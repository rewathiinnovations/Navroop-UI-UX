import { getEffectiveApiKey } from '@/lib/api-keys';
import { fallbackAltText } from '@/lib/assets/keys';
import { estimateTokenCost } from '@/lib/consumption/cost';
import { loadOperatorTokenRate, reportRateSource } from '@/lib/consumption/rates';
import { RunUsage } from '@/lib/consumption/run-usage';
import { trackFailure } from '@/lib/observability/track';
import { accrueSpend } from '@/lib/plans/spend';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';

/**
 * The alt text for a generated image, as a second model call.
 *
 * The call itself is not new; what it never did was cost anything on paper or
 * leave a trace when it failed. Both provider branches ended in a bare
 * `catch { /* fall through *\/ }` and a non-OK response was ignored, so an
 * expired key silently turned every alt text into an echo of the image prompt —
 * and the stack rules tell the model to treat that text as authoritative. The
 * image was metered, this call was not, so the spend ceiling never saw it.
 *
 * Both halves are fixed here: `RunUsage` charges the call (including a call the
 * provider accepted and then failed — it billed for the prompt either way) and
 * `trackFailure` says out loud that the sentence is a fallback.
 */

const OPENAI_MODEL = 'gpt-4o-mini';
const GEMINI_MODEL = 'gemini-2.0-flash';
const SYSTEM_PROMPT = 'Write a concise image alt text (max 12 words). No quotes.';

export type AltTextInput = {
  userId?: string | null;
  projectId: string;
  prompt: string;
};

type Attempt = {
  /** The sentence a provider produced, or null when none could. */
  text: string | null;
  /** Which provider answered, so the tokens are priced at its rate. */
  provider: string | null;
  model: string | null;
};

export async function generateAltText(input: AltTextInput): Promise<string> {
  const usage = new RunUsage();
  const failures: string[] = [];
  const attempt = await requestAltText(input, usage, failures);

  await chargeAltText(usage, attempt, input);

  if (failures.length > 0) {
    // Not a throw: a missing sentence must not throw away an image the provider
    // has already been paid for. But an operator whose alt text quietly became
    // prompt echoes had no signal at all, which is the finding.
    trackFailure('assets.alt_text_failed', new Error(failures.join('; ')), {
      action: 'alt_text',
      projectId: input.projectId,
      userId: input.userId ?? undefined,
    });
  }

  return attempt.text ?? fallbackAltText(input.prompt);
}

async function requestAltText(
  input: AltTextInput,
  usage: RunUsage,
  failures: string[],
): Promise<Attempt> {
  const openai = await getEffectiveApiKey(input.userId, 'openai');
  if (openai) {
    const text = await askOpenAI(openai, input.prompt, usage, failures);
    if (text) return { text, provider: 'openai', model: OPENAI_MODEL };
  }

  const google = await getEffectiveApiKey(input.userId, 'gemini');
  if (google) {
    const text = await askGemini(google, input.prompt, usage, failures);
    if (text) return { text, provider: 'gemini', model: GEMINI_MODEL };
  }

  // Whatever was attempted last is what the tokens belong to; with nothing
  // attempted there are no tokens and `chargeAltText` returns early.
  return { text: null, provider: openai ? 'openai' : google ? 'gemini' : null, model: null };
}

async function askOpenAI(
  apiKey: string,
  prompt: string,
  usage: RunUsage,
  failures: string[],
): Promise<string | null> {
  const body = JSON.stringify({
    model: OPENAI_MODEL,
    temperature: 0.2,
    max_tokens: 60,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  });
  usage.willSend(`${SYSTEM_PROMPT}\n${prompt}`);
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) {
      failures.push(`openai ${OPENAI_MODEL} answered ${response.status}`);
      return null;
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content?.replace(/\s+/g, ' ').trim();
    // Normalised here rather than in `readProviderInputTokens`: the wire names
    // are this provider's, and the accumulator speaks the SDK's.
    usage.settle(
      { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
      text ?? '',
    );
    if (text) return text;
    failures.push(`openai ${OPENAI_MODEL} returned no text`);
    return null;
  } catch (error) {
    failures.push(
      `openai ${OPENAI_MODEL} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function askGemini(
  apiKey: string,
  prompt: string,
  usage: RunUsage,
  failures: string[],
): Promise<string | null> {
  const instruction = `Write concise image alt text (max 12 words) for: ${prompt}`;
  usage.willSend(instruction);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: instruction }] }] }),
      },
    );
    if (!response.ok) {
      failures.push(`gemini ${GEMINI_MODEL} answered ${response.status}`);
      return null;
    }
    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/\s+/g, ' ').trim();
    usage.settle(
      {
        inputTokens: data.usageMetadata?.promptTokenCount,
        outputTokens: data.usageMetadata?.candidatesTokenCount,
      },
      text ?? '',
    );
    if (text) return text;
    failures.push(`gemini ${GEMINI_MODEL} returned no text`);
    return null;
  } catch (error) {
    failures.push(
      `gemini ${GEMINI_MODEL} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * The same accounting every other model call goes through: priced at the
 * operator's rate when they have confirmed one, and added to
 * `Workspace.spendUsd`, which is what the auto-pause ceiling reads.
 */
async function chargeAltText(usage: RunUsage, attempt: Attempt, input: AltTextInput) {
  const totals = usage.claim();
  if (!totals || totals.calls === 0) return;

  const rate = await loadOperatorTokenRate();
  const { usd, source } = estimateTokenCost({
    tokensIn: totals.tokensIn,
    tokensOut: totals.tokensOut,
    provider: attempt.provider,
    model: attempt.model,
    rate,
  });
  reportRateSource(source, { provider: attempt.provider, model: attempt.model });
  if (usd <= 0) return;

  await accrueSpend(WORKSPACE_ROW_ID, usd).catch((error) => {
    // A silent miss means the workspace keeps spending past its ceiling, which
    // is the same class of hole the unmetered call was.
    trackFailure('assets.alt_text_spend_failed', error, {
      action: 'alt_text',
      projectId: input.projectId,
      userId: input.userId ?? undefined,
      usd,
    });
  });
}
