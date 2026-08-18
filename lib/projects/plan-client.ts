/**
 * Client for retrying a failed PLAN. POSTs the recorded prompt to the
 * existing plan route. Fetch is the boundary — tests mock it. No AI calls.
 */
export async function retryProjectPlan(input: { projectId: string; prompt: string }) {
  const response = await fetch(`/api/projects/${input.projectId}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: input.prompt }),
  });
  const data = (await response.json().catch(() => null)) as { plan?: unknown; error?: unknown } | null;
  if (!response.ok) {
    const error = typeof data?.error === 'string' && data.error.trim() ? data.error : 'Could not start a plan.';
    throw new Error(error);
  }
  return { plan: data?.plan ?? null };
}
