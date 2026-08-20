import { z } from 'zod';
import { DESIGN_DIRECTION_IDS } from '@/lib/design/directions';
import { STACK_IDS } from '@/lib/stacks';
import { parseWithZod } from '@/lib/projects/schema';
import { httpUrl } from '@/lib/schema/url';
import { TEMPLATE_CATEGORIES } from './categories';

export const templateSortSchema = z.enum(['popular', 'newest']).default('popular');

export const listTemplatesQuerySchema = z.object({
  category: z.enum(TEMPLATE_CATEGORIES).optional(),
  stack: z.enum(STACK_IDS).optional(),
  sort: templateSortSchema,
});

export const saveTemplateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  description: z.string().trim().min(1, 'Description is required').max(240),
  category: z.enum(TEMPLATE_CATEGORIES),
  prompt: z.string().trim().min(20, 'Prompt is too short').max(12000),
  stack: z.enum(STACK_IDS).optional(),
  designDirection: z.enum(DESIGN_DIRECTION_IDS).optional(),
  // `.url()` accepted `javascript:` and `file:` — this value is shown as the
  // template's "Preview" link, which is the natural place for an href (F-742).
  previewUrl: httpUrl(500).optional().or(z.literal('')),
});

export const adminTemplateSchema = saveTemplateSchema.extend({
  slug: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use a lowercase slug like medical-clinic')
    .optional(),
  isActive: z.boolean().optional(),
  isBuiltIn: z.boolean().optional(),
  workspaceId: z.string().trim().min(1).nullable().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  previewUrl: httpUrl(500).nullable().optional().or(z.literal('')),
});

export const createFromTemplateSchema = z.object({
  prompt: z.string().trim().min(1, 'Prompt is required').max(12000).optional(),
  name: z.string().trim().min(1).max(100).optional(),
});

export { parseWithZod };
