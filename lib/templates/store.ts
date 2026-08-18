import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { isStackId } from '@/lib/stacks';
import { isTemplateCategory } from './categories';
import type { TemplateRow, TemplateSort } from './types';

function asRow(row: Record<string, unknown>): TemplateRow {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description),
    category: String(row.category),
    stack: String(row.stack),
    prompt: String(row.prompt),
    designDirection: row.designDirection == null ? null : String(row.designDirection),
    thumbnailKey: row.thumbnailKey == null ? null : String(row.thumbnailKey),
    previewUrl: row.previewUrl == null ? null : String(row.previewUrl),
    isActive: Boolean(row.isActive),
    isBuiltIn: Boolean(row.isBuiltIn),
    workspaceId: row.workspaceId == null ? null : String(row.workspaceId),
    createdById: row.createdById == null ? null : String(row.createdById),
    usageCount: Number(row.usageCount ?? 0),
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt)),
  };
}

export function slugifyName(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'template';
}

export function uniqueSlug(name: string) {
  return `${slugifyName(name)}-${randomBytes(3).toString('hex')}`;
}

export async function findTemplateById(id: string): Promise<TemplateRow | null> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT id, slug, name, description, category, stack, prompt, "designDirection",
      "thumbnailKey", "previewUrl", "isActive", "isBuiltIn", "workspaceId",
      "createdById", "usageCount", "sortOrder", "createdAt"
    FROM "Template" WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ? asRow(rows[0]) : null;
}

export async function findTemplateBySlug(slug: string): Promise<TemplateRow | null> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT id, slug, name, description, category, stack, prompt, "designDirection",
      "thumbnailKey", "previewUrl", "isActive", "isBuiltIn", "workspaceId",
      "createdById", "usageCount", "sortOrder", "createdAt"
    FROM "Template" WHERE slug = ${slug} LIMIT 1
  `;
  return rows[0] ? asRow(rows[0]) : null;
}

export async function listTemplateRows(opts: {
  workspaceId: string;
  includeInactive?: boolean;
  category?: string;
  stack?: string;
  sort?: TemplateSort;
}): Promise<TemplateRow[]> {
  const includeInactive = opts.includeInactive === true;
  const category = opts.category && isTemplateCategory(opts.category) ? opts.category : null;
  const stack = opts.stack && isStackId(opts.stack) ? opts.stack : null;
  const sort = opts.sort === 'newest' ? 'newest' : 'popular';

  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT id, slug, name, description, category, stack, prompt, "designDirection",
      "thumbnailKey", "previewUrl", "isActive", "isBuiltIn", "workspaceId",
      "createdById", "usageCount", "sortOrder", "createdAt"
    FROM "Template"
    WHERE ("workspaceId" IS NULL OR "workspaceId" = ${opts.workspaceId})
      AND (${includeInactive} OR "isActive" = true)
      AND (${category}::text IS NULL OR category = ${category})
      AND (${stack}::text IS NULL OR stack::text = ${stack})
    ORDER BY
      CASE WHEN ${sort} = 'popular' THEN "usageCount" END DESC NULLS LAST,
      CASE WHEN ${sort} = 'newest' THEN "createdAt" END DESC NULLS LAST,
      "sortOrder" ASC,
      "createdAt" DESC
  `;
  return rows.map(asRow);
}

export async function insertTemplate(input: {
  slug: string;
  name: string;
  description: string;
  category: string;
  stack: string;
  prompt: string;
  designDirection?: string | null;
  thumbnailKey?: string | null;
  previewUrl?: string | null;
  isActive?: boolean;
  isBuiltIn?: boolean;
  workspaceId?: string | null;
  createdById?: string | null;
  sortOrder?: number;
}): Promise<TemplateRow> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    INSERT INTO "Template" (
      id, slug, name, description, category, stack, prompt, "designDirection",
      "thumbnailKey", "previewUrl", "isActive", "isBuiltIn", "workspaceId",
      "createdById", "usageCount", "sortOrder", "createdAt"
    ) VALUES (
      ${`tmpl_${randomBytes(8).toString('hex')}`},
      ${input.slug},
      ${input.name},
      ${input.description},
      ${input.category},
      ${input.stack}::"Stack",
      ${input.prompt},
      ${input.designDirection ?? null},
      ${input.thumbnailKey ?? null},
      ${input.previewUrl ?? null},
      ${input.isActive !== false},
      ${input.isBuiltIn === true},
      ${input.workspaceId ?? null},
      ${input.createdById ?? null},
      0,
      ${input.sortOrder ?? 0},
      NOW()
    )
    RETURNING id, slug, name, description, category, stack, prompt, "designDirection",
      "thumbnailKey", "previewUrl", "isActive", "isBuiltIn", "workspaceId",
      "createdById", "usageCount", "sortOrder", "createdAt"
  `;
  return asRow(rows[0]);
}

export async function updateTemplateRow(
  id: string,
  patch: Partial<{
    slug: string;
    name: string;
    description: string;
    category: string;
    stack: string;
    prompt: string;
    designDirection: string | null;
    thumbnailKey: string | null;
    previewUrl: string | null;
    isActive: boolean;
    isBuiltIn: boolean;
    workspaceId: string | null;
    sortOrder: number;
  }>,
): Promise<TemplateRow | null> {
  const current = await findTemplateById(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    UPDATE "Template" SET
      slug = ${next.slug},
      name = ${next.name},
      description = ${next.description},
      category = ${next.category},
      stack = ${String(next.stack)}::"Stack",
      prompt = ${next.prompt},
      "designDirection" = ${next.designDirection},
      "thumbnailKey" = ${next.thumbnailKey},
      "previewUrl" = ${next.previewUrl},
      "isActive" = ${next.isActive},
      "isBuiltIn" = ${next.isBuiltIn},
      "workspaceId" = ${next.workspaceId},
      "sortOrder" = ${next.sortOrder}
    WHERE id = ${id}
    RETURNING id, slug, name, description, category, stack, prompt, "designDirection",
      "thumbnailKey", "previewUrl", "isActive", "isBuiltIn", "workspaceId",
      "createdById", "usageCount", "sortOrder", "createdAt"
  `;
  return rows[0] ? asRow(rows[0]) : null;
}

export async function deleteTemplateRow(id: string) {
  await prisma.$executeRaw`DELETE FROM "Template" WHERE id = ${id}`;
}

export async function upsertBuiltInTemplate(input: {
  slug: string;
  name: string;
  description: string;
  category: string;
  stack: string;
  prompt: string;
  designDirection: string;
  sortOrder: number;
}) {
  await prisma.$executeRaw`
    INSERT INTO "Template" (
      id, slug, name, description, category, stack, prompt, "designDirection",
      "isActive", "isBuiltIn", "workspaceId", "usageCount", "sortOrder", "createdAt"
    ) VALUES (
      ${`tmpl_${input.slug}`},
      ${input.slug},
      ${input.name},
      ${input.description},
      ${input.category},
      ${input.stack}::"Stack",
      ${input.prompt},
      ${input.designDirection},
      true,
      true,
      NULL,
      0,
      ${input.sortOrder},
      NOW()
    )
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      category = EXCLUDED.category,
      stack = EXCLUDED.stack,
      prompt = EXCLUDED.prompt,
      "designDirection" = EXCLUDED."designDirection",
      "isBuiltIn" = true,
      "sortOrder" = EXCLUDED."sortOrder"
  `;
}
