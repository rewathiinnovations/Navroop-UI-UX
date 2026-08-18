export const PUBLISH_STEPS = [
  { id: 1, key: 'limit', label: 'Checking limits' },
  { id: 2, key: 'files', label: 'Preparing files' },
  { id: 3, key: 'slug', label: 'Preparing files' },
  { id: 4, key: 'github', label: 'Sending code to GitHub' },
  { id: 5, key: 'app', label: 'Creating the app on the server' },
  { id: 6, key: 'dns', label: 'Connecting the domain' },
  { id: 7, key: 'domain', label: 'Connecting the domain' },
  { id: 8, key: 'deploy', label: 'Build in progress' },
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
