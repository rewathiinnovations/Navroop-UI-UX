export const CREDIT_ACTIONS = ['generation', 'image', 'import', 'audit', 'evolution'] as const;
export type CreditAction = (typeof CREDIT_ACTIONS)[number];

export const LIMIT_KINDS = ['projects', 'liveSites', 'previewSites', 'members', 'storage'] as const;
export type LimitKind = (typeof LIMIT_KINDS)[number];

export type CreditDenialReason = 'paused' | 'workspace_exhausted' | 'member_cap';

export type CreditCheckOk = { ok: true; cost: number };
export type CreditCheckDenied = {
  ok: false;
  reason: CreditDenialReason;
  used: number;
  limit: number;
  message: string;
};
export type CreditCheckResult = CreditCheckOk | CreditCheckDenied;

export type LimitCheckResult = {
  ok: boolean;
  current: number;
  limit: number;
  reason?: LimitKind;
  message?: string;
};

export type PublicPlan = {
  id: string;
  key: string;
  name: string;
  isActive: boolean;
  isDefault: boolean;
  monthlyCredits: number;
  maxProjects: number;
  maxLiveSites: number;
  maxPreviewSites: number;
  maxMembers: number;
  checkpointRetentionDays: number;
  storageBytesLimit: string;
  allowCustomDomain: boolean;
  allowGithubSync: boolean;
  maxTokensPerJob: number;
  maxFilesPerJob: number;
  maxOutputBytesPerJob: number;
};
