/**
 * DeepSeek thinking-mode models reject a `temperature`, so the option has to be
 * omitted rather than set for them. Thinking is now enabled for every DeepSeek
 * model (the reasoning default `deepseek-v4-flash` and the `-pro` tier); the
 * only non-reasoning model was `deepseek-chat`, which is no longer offered.
 *
 * That rule was stated in one place and violated in another. The main stream call guarded
 * it (`if (!actualModel.includes('-pro'))`); the truncation-recovery call decided with
 * `recoveryEntry.model.startsWith('gpt-5') ? undefined : defaultTemperature` — a dead
 * OpenAI test that can never be true for a DeepSeek id, so `deepseek-v4-pro` received a
 * temperature and every recovery call on the stronger model was rejected by the provider.
 * The run then reported the truncated files as kept and named a provider failure, i.e.
 * truncation recovery was entirely non-functional on that model and the user was told it
 * was the vendor's fault. One decision, used by every call site (F-041).
 *
 * The model id is unused for the verdict today, because DeepSeek's rule is about the
 * reasoning mode rather than the model name. It stays in the signature — every call site
 * passes the id it is about to send — so a provider whose rule *is* per-model is an edit to
 * this function alone, not to the call sites that would otherwise have to relearn the rule
 * this file exists to hold.
 *
 * "Every call site" was aspirational until it was enforced. The main stream, the corrective
 * ask and truncation recovery came here; memory extraction kept a literal `temperature: 0`
 * and the settle of every generation was refused by the provider into a catch that reported
 * success. `tests/unit/one-temperature-decision.test.ts` now walks the tree and fails on the
 * next one, so this paragraph is a description rather than a hope.
 *
 * `thinking` is the caller's reading of the mode the request will actually be sent in, not a
 * guess from the model id: `DEEPSEEK_THINKING` is an operator setting (`ai.deepseek.thinking`)
 * and both halves of a request have to come from one reading of it, or a run sends thinking
 * *and* a temperature and is refused outright.
 *
 * **The default deployment has thinking enabled, so this returns `undefined` and nothing
 * changes until an operator turns thinking off.** Codegen wants a low, non-zero temperature
 * — deterministic enough to follow a locked stack, loose enough not to repeat one layout —
 * and 0.3 sits at the bottom of the usual 0.2–0.4 band for code.
 */
export const CODEGEN_TEMPERATURE = 0.3;

export function temperatureForModel(
  _model: string,
  options: { thinking: boolean },
): number | undefined {
  // Omitted, never zero: a thinking model rejects the field's presence, and
  // `JSON.stringify` drops an `undefined` value rather than sending `null`.
  return options.thinking ? undefined : CODEGEN_TEMPERATURE;
}
