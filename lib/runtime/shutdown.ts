import { log, logError } from '@/lib/logger';
import { abandonInstanceJobs } from '@/lib/jobs/lifecycle';

let wired = false;

export function wireShutdownDrain() {
  if (wired || process.env.NEXT_RUNTIME === 'edge') return;
  wired = true;

  const drain = async (signal: string) => {
    log.warn('runtime.shutdown_drain', { signal });
    try {
      const count = await abandonInstanceJobs('deploying');
      log.warn('runtime.shutdown_drained', { signal, abandoned: count });
    } catch (error) {
      logError('runtime.shutdown_drain_failed', error, { signal });
    }
  };

  process.on('SIGTERM', () => {
    void drain('SIGTERM').finally(() => {
      process.exit(0);
    });
  });
}
