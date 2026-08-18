export const JOB_CAP_MESSAGE = 'This build got too large — try a shorter prompt';
export const LOOP_DETECTED_MESSAGE = 'Loop detected — the same file was rewritten too many times';

export type JobCaps = {
  maxTokensPerJob: number;
  maxFilesPerJob: number;
  maxOutputBytesPerJob: number;
};

export type PartialCapFile = { path: string; content: string };

export class JobCapError extends Error {
  readonly errorCode: 'job_cap_exceeded' | 'loop_detected';
  readonly tokensOut: number;
  readonly files: number;
  readonly bytes: number;

  constructor(
    errorCode: 'job_cap_exceeded' | 'loop_detected',
    message: string,
    stats: { tokensOut: number; files: number; bytes: number },
  ) {
    super(message);
    this.name = 'JobCapError';
    this.errorCode = errorCode;
    this.tokensOut = stats.tokensOut;
    this.files = stats.files;
    this.bytes = stats.bytes;
  }
}

export function estimateOutputTokens(text: string) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function byteLength(text: string) {
  return Buffer.byteLength(text, 'utf8');
}

export class JobCapTracker {
  tokensOut = 0;
  bytes = 0;
  files = 0;
  readonly partialFiles: PartialCapFile[] = [];
  private readonly writes = new Map<string, number>();
  private readonly caps: JobCaps;

  constructor(caps: JobCaps) {
    this.caps = caps;
  }

  private stats() {
    return { tokensOut: this.tokensOut, files: this.files, bytes: this.bytes };
  }

  private overCap() {
    return (
      this.tokensOut > this.caps.maxTokensPerJob ||
      this.bytes > this.caps.maxOutputBytesPerJob ||
      this.files > this.caps.maxFilesPerJob
    );
  }

  addTokens(count: number): JobCapError | null {
    this.tokensOut += Math.max(0, count);
    if (this.overCap()) {
      return new JobCapError('job_cap_exceeded', JOB_CAP_MESSAGE, this.stats());
    }
    return null;
  }

  addChunk(text: string): JobCapError | null {
    if (!text) return null;
    this.bytes += byteLength(text);
    this.tokensOut += estimateOutputTokens(text);
    if (this.overCap()) {
      return new JobCapError('job_cap_exceeded', JOB_CAP_MESSAGE, this.stats());
    }
    return null;
  }

  addFile(path: string, content: string): JobCapError | null {
    const writes = (this.writes.get(path) ?? 0) + 1;
    this.writes.set(path, writes);
    if (writes > 3) {
      return new JobCapError('loop_detected', LOOP_DETECTED_MESSAGE, this.stats());
    }
    const existing = this.partialFiles.findIndex((file) => file.path === path);
    if (existing === -1) {
      this.files += 1;
      if (this.files > this.caps.maxFilesPerJob) {
        this.files -= 1;
        return new JobCapError('job_cap_exceeded', JOB_CAP_MESSAGE, this.stats());
      }
      this.partialFiles.push({ path, content });
    } else {
      this.partialFiles[existing] = { path, content };
    }
    return null;
  }
}

export const DEFAULT_JOB_CAPS: JobCaps = {
  maxTokensPerJob: 120_000,
  maxFilesPerJob: 60,
  maxOutputBytesPerJob: 2_000_000,
};
