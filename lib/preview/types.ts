export type PreviewMode = 'STATIC' | 'LIVE_SANDBOX';
export type PreviewBuildStatus = 'PENDING' | 'BUILDING' | 'READY' | 'FAILED';

export type PreviewCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type PreviewSandbox = {
  runCommand: (command: string) => Promise<PreviewCommandResult>;
  listFiles: (dir: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string | Buffer>;
  writeFile: (path: string, content: string) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
};

export type PreviewBuildStore = {
  createBuilding: (input: {
    projectId: string;
    checkpointId: string;
    mode: PreviewMode;
  }) => Promise<{ id: string; status: string; mode: string }>;
  markFailed: (
    id: string,
    input: { error?: string | null; buildLog?: string | null; mode?: PreviewMode },
  ) => Promise<void>;
  markReady: (
    id: string,
    input: {
      storagePrefix: string;
      entryPath: string;
      isSpa: boolean;
      fileCount: number;
      totalBytes: number;
      buildLog?: string | null;
      mode: PreviewMode;
    },
  ) => Promise<void>;
  setProjectPreview: (
    projectId: string,
    input: {
      previewMode: PreviewMode;
      activePreviewBuildId: string | null;
      fromBuildId?: string;
    },
  ) => Promise<void>;
};

export type PreviewStorage = {
  upload: (input: {
    key: string;
    body: Buffer;
    contentType: string;
    gzip?: boolean;
  }) => Promise<void>;
};

export type BuildStaticPreviewDeps = {
  stack: string;
  sandbox: PreviewSandbox;
  store: PreviewBuildStore;
  storage: PreviewStorage;
  killSandbox: (projectId: string) => Promise<void>;
};

export type BuildStaticPreviewResult =
  | { ok: true; mode: 'STATIC'; buildId: string }
  | { ok: false; mode: 'LIVE_SANDBOX'; buildId: string; error: string };
