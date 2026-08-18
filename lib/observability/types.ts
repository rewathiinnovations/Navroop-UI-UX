export type ObservabilityCheckKind = 'heartbeat' | 'quota' | 'dsn_config';

export type ObservabilityCheckRow = {
  id: string;
  kind: string;
  ok: boolean;
  detail: string | null;
  eventId: string | null;
  createdAt: Date;
};

export type CronRunRow = {
  id: string;
  name: string;
  ok: boolean;
  durationMs: number | null;
  detail: string | null;
  createdAt: Date;
};

export type ObservabilityStore = {
  createCheck: (row: Omit<ObservabilityCheckRow, 'id'> & { id?: string }) => Promise<ObservabilityCheckRow>;
  listChecks: (kind?: string) => Promise<ObservabilityCheckRow[]>;
  createCronRun: (row: Omit<CronRunRow, 'id'> & { id?: string }) => Promise<CronRunRow>;
  listCronRuns: (name?: string) => Promise<CronRunRow[]>;
};

export type ObservabilityEmail = {
  subject: string;
  html: string;
  text: string;
  emailClass?: 'security' | 'workspace';
};

export type SendAdminEmail = (mail: ObservabilityEmail) => Promise<void>;

export type SentryIssueHit = {
  id: string;
  lastSeen: string;
  title?: string;
  count?: number;
};

export type SentryDropped = { reason: string; count: number };

export type SentryProjectStats = {
  accepted: number;
  dropped: SentryDropped[];
  quota: { used: number; limit: number; resetsAt: string | null };
  topIssues: Array<{ id: string; title: string; count: number }>;
};

export type SentryApi = {
  getProjectStats: () => Promise<SentryProjectStats>;
  findIssueByFingerprint: (fingerprint: string) => Promise<SentryIssueHit | null>;
};

export type ErrorTrackingStatus = 'Healthy' | 'Degraded' | 'Not reporting';

export type ErrorTrackingPanel = {
  status: ErrorTrackingStatus;
  lastSuccessfulSendAt: string | null;
  lastConfirmedReceiptAt: string | null;
  quota: { used: number; limit: number; resetsAt: string | null } | null;
  dropped24h: SentryDropped[];
  topIssues: Array<{ id: string; title: string; count: number }>;
  dsnProjectId: string | null;
  environment: string;
  releaseSha: string;
  dsnConfigured: boolean;
};

export type SystemCheckRow = {
  name: string;
  lastRunAt: string | null;
  ok: boolean | null;
  stale: boolean;
  detail: string | null;
};
