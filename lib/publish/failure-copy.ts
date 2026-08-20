import { PUBLISH_STEPS, stepLabel, type PublishStepKey } from './steps';
import type { PublicDeployment } from './types';

/**
 * What a failed deployment tells the user, in one place (F-260).
 *
 * `lastError`, `progressStep` and `buildLogUrl` were serialised and rendered nowhere on
 * `/deployments`: the table showed "Failed" and three buttons, so recovery was "press
 * Redeploy and hope". Both surfaces that report a publish — the workspace publish sheet and
 * the workspace-wide deployments table — now shape the row through here, so they cannot
 * disagree about which step died or whether a reason exists.
 *
 * Pure, and imported by two `'use client'` components: nothing runtime beyond `./steps`
 * (also pure) may be imported here. `./types` is the same type-only boundary `serialize.ts`
 * documents.
 */

/**
 * Said instead of an empty paragraph. `markDeploymentFailed` always writes a message, but a
 * row failed by `compensateAbandonedPublish` after an instance restart can carry none, and
 * "Failed" with a blank line under it is what this replaces.
 */
export const NO_FAILURE_REASON_RECORDED =
  'No reason was recorded for this failure. The build log has the server-side detail.';

export type DeploymentFailure = {
  /** Names the step that died, so the user knows how far the publish got. */
  headline: string;
  reason: string;
  requestId: string | null;
  buildLogUrl: string | null;
};

type FailureInput = Pick<
  PublicDeployment,
  'status' | 'progressStep' | 'lastError' | 'lastRequestId' | 'buildLogUrl'
>;

function present(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * `null` for anything that is not a failure. A LIVE or STOPPED row keeps whatever
 * `lastError` its last failed attempt wrote, and surfacing that under a running site would
 * be the same class of lie the stop/refusal copy was fixed for.
 */
export function deploymentFailure(row: FailureInput): DeploymentFailure | null {
  if (row.status !== 'FAILED') return null;

  const step = present(row.progressStep);
  // `stepLabel` answers 'Publishing' for an unknown key; a step name the stepper does not
  // define would be worse than no step name, so only a real key earns the specific headline.
  const known = step && PUBLISH_STEPS.some((entry) => entry.key === step);

  return {
    headline: known ? `Failed at ${stepLabel(step as PublishStepKey)}` : 'Publish failed',
    reason: present(row.lastError) ?? NO_FAILURE_REASON_RECORDED,
    requestId: present(row.lastRequestId),
    buildLogUrl: present(row.buildLogUrl),
  };
}
