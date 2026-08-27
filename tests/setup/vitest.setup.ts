import { afterEach } from 'vitest';
import './data-dir-guard';
// Belt to the global setup's braces. The fence is normally inherited from the main
// process, but `tests/setup/env.ts` loads `.env.local` and `.env.test` with
// `override: true` before this file runs, so either could hand a worker a storage
// root back inside the repository. Re-applying it here means no worker can be
// pointed at `public/uploads` however the environment was assembled.
import './storage-dir-guard';
import { resetAllowedHosts, revokeLocalhost } from './network-guard';

afterEach(() => {
  revokeLocalhost();
  resetAllowedHosts();
});
