import { InvalidToolInputError, NoSuchToolError, ToolCallRepairError } from 'ai';

/**
 * Whether a thrown error is the AI SDK refusing a tool call the model asked for.
 *
 * This used to be decided by `errorMessage.includes('tool call validation failed')`, which
 * is fragile in the direction that hurts: any change in the SDK's wording silently reroutes
 * the run to the generic provider-error path, and the phrase could be produced by a
 * provider message that has nothing to do with a tool call. The SDK ships type predicates
 * for exactly this, so use them — and look through a wrapper's `cause`, because the
 * generation route sees these inside `ProviderRunError` (F-038).
 */
export function isToolCallValidationError(error: unknown): boolean {
  if (
    NoSuchToolError.isInstance(error) ||
    InvalidToolInputError.isInstance(error) ||
    ToolCallRepairError.isInstance(error)
  ) {
    return true;
  }
  if (error && typeof error === 'object' && 'cause' in error && error.cause !== error) {
    return isToolCallValidationError(error.cause);
  }
  return false;
}
