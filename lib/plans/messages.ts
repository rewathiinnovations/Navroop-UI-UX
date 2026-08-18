import type { CreditAction, CreditDenialReason, LimitKind } from './types';

export const CREDIT_DENIAL_MESSAGES: Record<CreditDenialReason, string> = {
  workspace_exhausted: "This month's credits are used up",
  member_cap: 'Your personal limit is used up — ask an admin to raise it',
  paused: 'An admin has paused generation',
};

export const LIMIT_DENIAL_MESSAGES: Record<LimitKind, string> = {
  projects: "Your plan's project limit is used up",
  liveSites: "Your plan's live site limit is used up",
  previewSites: "Your plan's preview limit is used up",
  members: "Your plan's member limit is used up",
  storage: 'Workspace storage limit is used up',
};

export function creditDenialMessage(reason: CreditDenialReason) {
  return CREDIT_DENIAL_MESSAGES[reason];
}

export function limitDenialMessage(kind: LimitKind) {
  return LIMIT_DENIAL_MESSAGES[kind];
}

export function actionLabel(action: CreditAction) {
  switch (action) {
    case 'generation':
      return 'Generation';
    case 'image':
      return 'Image';
    case 'import':
      return 'Import';
    case 'audit':
      return 'Audit';
    case 'evolution':
      return 'Evolution';
    default:
      return action;
  }
}
