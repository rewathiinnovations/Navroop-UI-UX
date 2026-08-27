export type PreviewMode = 'STATIC';
export type PreviewBuildStatus = 'PENDING' | 'BUILDING' | 'READY' | 'FAILED';

export type PreviewBuildStore = {
  createBuilding: (input: {
    projectId: string;
    checkpointId: string;
    mode: PreviewMode;
  }) => Promise<{ id: string; status: string; mode: string }>;
  markFailed: (
    id: string,
    input: {
      error?: string | null;
      buildLog?: string | null;
      mode?: PreviewMode;
      /** Names the objects a half-finished upload left behind, for the pruner. */
      storagePrefix?: string | null;
    },
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
  /** The project's source files, keyed by repo-relative path. */
  files: Record<string, string>;
  /** Decides the starter kit's token block, so the served build matches the tab's. */
  designDirection?: string | null;
  store: PreviewBuildStore;
  storage: PreviewStorage;
};

export type BuildStaticPreviewResult =
  { ok: true; mode: 'STATIC'; buildId: string } | { ok: false; buildId: string; error: string };
