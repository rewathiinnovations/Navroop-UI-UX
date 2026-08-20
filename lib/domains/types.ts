export const CUSTOM_DOMAIN_STATUSES = [
  'PENDING_DNS',
  'VERIFYING',
  'SSL_PENDING',
  'ACTIVE',
  'FAILED',
] as const;
export type CustomDomainStatus = (typeof CUSTOM_DOMAIN_STATUSES)[number];

export const CUSTOM_DOMAIN_PATHS = ['A', 'B'] as const;
export type CustomDomainPath = (typeof CUSTOM_DOMAIN_PATHS)[number];

export type CustomDomainRow = {
  id: string;
  deploymentId: string;
  workspaceId: string;
  hostname: string;
  status: CustomDomainStatus;
  verifyToken: string;
  expectedTarget: string;
  lastCheckedAt: Date | null;
  lastError: string | null;
  sslIssuedAt: Date | null;
  isPrimary: boolean;
  path: CustomDomainPath;
  cloudflareZoneId: string | null;
  nameservers: string[] | null;
  createdAt: Date;
};

export type DnsInstruction = {
  type: 'A' | 'CNAME' | 'TXT' | 'NS';
  name: string;
  value: string;
  ttl: string;
};

export type PublicCustomDomain = CustomDomainRow & {
  instructions: DnsInstruction[];
  publishedHost: string;
  timeline: Array<{ id: string; label: string; done: boolean; current: boolean }>;
};

export type DnsLookup<T> =
  | { status: 'records'; records: T }
  | { status: 'no-records' }
  | { status: 'failed'; reason: string };

export type DomainDns = {
  resolveTxt: (name: string) => Promise<DnsLookup<string[][]>>;
  resolve4: (name: string) => Promise<DnsLookup<string[]>>;
  resolveCname: (name: string) => Promise<DnsLookup<string[]>>;
};

export const CUSTOM_DOMAIN_LOCKED_MESSAGE = 'This feature is not on your plan yet';
export const PATH_B_COPY = 'After this, we will handle all domain work for you.';
export const DNS_PROPAGATION_NOTE = 'DNS can take 5 minutes to 24 hours to update.';

export const TIMELINE_STEPS = [
  { id: 'added', label: 'Added' },
  { id: 'dns', label: 'DNS found' },
  { id: 'ssl', label: 'SSL issuing' },
  { id: 'live', label: 'Live' },
] as const;
