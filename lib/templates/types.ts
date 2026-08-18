import type { Stack } from '@/generated/prisma';
import type { TemplateCategory } from './categories';

export type TemplateRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  stack: Stack | string;
  prompt: string;
  designDirection: string | null;
  thumbnailKey: string | null;
  previewUrl: string | null;
  isActive: boolean;
  isBuiltIn: boolean;
  workspaceId: string | null;
  createdById: string | null;
  usageCount: number;
  sortOrder: number;
  createdAt: Date;
};

export type PublicTemplate = {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: TemplateCategory | string;
  stack: string;
  prompt: string;
  designDirection: string | null;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  isActive: boolean;
  isBuiltIn: boolean;
  workspaceId: string | null;
  usageCount: number;
  sortOrder: number;
  createdAt: string;
};

export type TemplateSort = 'popular' | 'newest';
