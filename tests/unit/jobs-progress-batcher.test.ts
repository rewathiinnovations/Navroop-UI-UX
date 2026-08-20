import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The progress batcher used to rewrite every partial file it had ever seen,
 * every two seconds, whether or not anything changed — and it re-read the row to
 * merge and then `updateJobFields` read it back again: three round trips and ~2×
 * the project's bytes, twice a second, for the whole build (F-034).
 *
 * These pin the fixed behaviour: one write per flush that has new work, no write
 * at all when nothing changed, the row read at most once, and `setStep`
 * persisting on its own.
 */

const applyJobFields = vi.fn(async () => undefined);
const getJob = vi.fn(async () => ({ partialFiles: [] as { path: string; content: string }[] }));

vi.mock('@/lib/jobs/store', () => ({ applyJobFields, getJob }));

const { createProgressBatcher } = await import('@/lib/jobs/progress');

type WriteFields = {
  partialFiles?: { path: string; content: string }[];
  filesWritten?: number;
  lastStep?: string | null;
};

function lastWrite(): WriteFields {
  return applyJobFields.mock.calls[applyJobFields.mock.calls.length - 1]?.[1] as WriteFields;
}

beforeEach(() => {
  applyJobFields.mockClear();
  getJob.mockClear();
  getJob.mockResolvedValue({ partialFiles: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createProgressBatcher', () => {
  // A long interval so the internal timer never fires; `flush()` is driven by hand.
  const interval = 1_000_000;

  it('writes every pending file exactly once per flush', async () => {
    const batcher = createProgressBatcher('job-1', interval);
    batcher.addFile('a.tsx', 'A');
    batcher.addFile('b.tsx', 'B');
    await batcher.flush();

    expect(applyJobFields).toHaveBeenCalledTimes(1);
    const write = lastWrite();
    expect(write.partialFiles).toEqual([
      { path: 'a.tsx', content: 'A' },
      { path: 'b.tsx', content: 'B' },
    ]);
    expect(write.filesWritten).toBe(2);
  });

  it('writes nothing when a flush has no new work', async () => {
    const batcher = createProgressBatcher('job-2', interval);
    batcher.addFile('a.tsx', 'A');
    await batcher.flush();
    applyJobFields.mockClear();

    // Second flush, nothing added since: the old batcher re-sent everything here.
    await batcher.flush();
    expect(applyJobFields).not.toHaveBeenCalled();
  });

  it('reads the row at most once across many flushes', async () => {
    const batcher = createProgressBatcher('job-3', interval);
    batcher.addFile('a.tsx', 'A');
    await batcher.flush();
    batcher.addFile('b.tsx', 'B');
    await batcher.flush();
    batcher.addFile('c.tsx', 'C');
    await batcher.flush();

    // The row is read once to seed what an earlier attempt left; never per flush.
    expect(getJob).toHaveBeenCalledTimes(1);
    // Each flush still writes the full set (jsonb column), but only when there is
    // something new — three flushes, three files added, three writes.
    expect(applyJobFields).toHaveBeenCalledTimes(3);
    expect(lastWrite().partialFiles).toEqual([
      { path: 'a.tsx', content: 'A' },
      { path: 'b.tsx', content: 'B' },
      { path: 'c.tsx', content: 'C' },
    ]);
  });

  it('merges files an earlier attempt left on the row', async () => {
    getJob.mockResolvedValue({ partialFiles: [{ path: 'old.tsx', content: 'OLD' }] });
    const batcher = createProgressBatcher('job-4', interval);
    batcher.addFile('new.tsx', 'NEW');
    await batcher.flush();

    expect(lastWrite().partialFiles).toEqual([
      { path: 'old.tsx', content: 'OLD' },
      { path: 'new.tsx', content: 'NEW' },
    ]);
  });

  it('persists a step with no file, which the old batcher never did', async () => {
    const batcher = createProgressBatcher('job-5', interval);
    batcher.setStep('installing packages');
    await batcher.flush();

    expect(applyJobFields).toHaveBeenCalledTimes(1);
    const write = lastWrite();
    expect(write.lastStep).toBe('installing packages');
    // No file was added, so no partial-file write rides along.
    expect(write.partialFiles).toBeUndefined();
    // Flushing again with the same step writes nothing new.
    applyJobFields.mockClear();
    await batcher.flush();
    expect(applyJobFields).not.toHaveBeenCalled();
  });

  it('keeps work queued when a write fails, retrying it on the next flush', async () => {
    const batcher = createProgressBatcher('job-6', interval);
    batcher.addFile('a.tsx', 'A');
    applyJobFields.mockRejectedValueOnce(new Error('db down'));
    await expect(batcher.flush()).rejects.toThrow('db down');

    // The file was not dropped: the next flush writes it.
    await batcher.flush();
    expect(lastWrite().partialFiles).toEqual([{ path: 'a.tsx', content: 'A' }]);
  });
});
