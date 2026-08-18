import { reconcileJobsAtBoot } from '../lib/jobs/boot.ts';

const result = await reconcileJobsAtBoot();
if ('error' in result && result.error) {
  console.error('[navroop] job reconcile failed');
  process.exit(1);
}
console.log('[navroop] job reconcile complete');
