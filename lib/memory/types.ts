export const MEMORY_SCOPES = ['WORKSPACE', 'PROJECT'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_CATEGORIES = ['design', 'tech', 'content', 'context'] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_SOURCES = ['manual', 'extracted'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export const MEMORY_STATUSES = ['ACTIVE', 'PENDING', 'ARCHIVED'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_TOKEN_BUDGET = 1500;

export const MEMORY_EXTRACTION_SETTING_KEY = 'memoryExtractionEnabled';

export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  category: MemoryCategory;
  content: string;
  source: MemorySource;
  status: MemoryStatus;
  createdAt: Date;
};

export type MemoryBlockResult = {
  block: string;
  truncated: boolean;
  /** Scopes that lost at least one ACTIVE row to the budget, so a warning can name them. */
  truncatedScopes: MemoryScope[];
  tokenEstimate: number;
};

export type PublicMemory = {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  category: MemoryCategory;
  content: string;
  source: MemorySource;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
};
