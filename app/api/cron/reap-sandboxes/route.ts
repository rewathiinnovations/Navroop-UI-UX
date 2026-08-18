import { handleCron } from '@/lib/cron/handle';
import { reapIdleSandboxes } from '@/lib/sandbox/reap';

export async function POST(request: Request) {
  return handleCron('reap-sandboxes', request, async () => {
    const result = await reapIdleSandboxes();
    console.log(
      `[reap-sandboxes] reaped ${result.reaped} idle sandbox(es) (candidates=${result.candidates}, accruedMinutes=${result.accrued})`,
    );
    return { ok: true, ...result };
  });
}
