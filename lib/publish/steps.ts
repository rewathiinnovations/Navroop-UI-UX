/**
 * The ten-step publish machine.
 *
 * Every label is distinct. Three pairs used to share one — `files`/`slug`, `dns`/`domain`,
 * `deploy`/`poll` — on the grounds that `PUBLISH_STEPPER` collapses them for the sheet. But
 * these labels are also written onto `GenerationJob.steps` and rendered one per line by
 * `RecoveryPanel`, so a failure at `slug` was reported to the user as "Preparing files" —
 * the name of the step that had already succeeded — and the recovery list printed three
 * duplicate rows (F-253). The stepper still collapses; the steps now name themselves.
 */
export const PUBLISH_STEPS = [
  { id: 1, key: 'limit', label: 'Checking limits' },
  { id: 2, key: 'files', label: 'Preparing files' },
  { id: 3, key: 'slug', label: 'Reserving the address' },
  { id: 4, key: 'github', label: 'Sending code to GitHub' },
  { id: 5, key: 'app', label: 'Creating the app on the server' },
  { id: 6, key: 'dns', label: 'Pointing DNS at the server' },
  { id: 7, key: 'domain', label: 'Connecting the domain' },
  { id: 8, key: 'deploy', label: 'Starting the build' },
  { id: 9, key: 'poll', label: 'Build in progress' },
  { id: 10, key: 'live', label: 'Site is live' },
] as const;

export type PublishStepKey = (typeof PUBLISH_STEPS)[number]['key'];

/** Six stepper rows shown in the publish sheet (maps the 10-step machine). */
export const PUBLISH_STEPPER = [
  { keys: ['limit', 'files', 'slug'] as PublishStepKey[], label: 'Preparing files' },
  { keys: ['github'] as PublishStepKey[], label: 'Sending code to GitHub' },
  { keys: ['app'] as PublishStepKey[], label: 'Creating the app on the server' },
  { keys: ['dns', 'domain'] as PublishStepKey[], label: 'Connecting the domain' },
  { keys: ['deploy', 'poll'] as PublishStepKey[], label: 'Build in progress' },
  { keys: ['live'] as PublishStepKey[], label: 'Site is live' },
] as const;

export function stepLabel(key: PublishStepKey | string | null | undefined) {
  return PUBLISH_STEPS.find((step) => step.key === key)?.label ?? 'Publishing';
}

export function stepperIndex(key: PublishStepKey | string | null | undefined) {
  const index = PUBLISH_STEPPER.findIndex((row) => row.keys.includes(key as PublishStepKey));
  return index < 0 ? 0 : index;
}
