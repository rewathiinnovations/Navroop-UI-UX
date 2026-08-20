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

/**
 * Writes the columns in `patch` and nothing else.
 *
 * This was a read-modify-write: it read the row, merged the patch in JS, and `UPDATE`d
 * all thirteen columns from the merged object. Anything committed between the read and
 * the write was overwritten with the stale value, so two admins editing one template —
 * or one admin's reorder racing their own content edit — silently reverted each other,
 * and the reverted column is the prompt every project from that template is built from
 * (F-748). `incrementUsageCount` next door is atomic for the same reason.
 *
 * `Template` has no `updatedAt`/version column, so there is no predicate that can refuse
 * a stale write to the *same* column; last write wins there, as it does in the admin form.
 * Restricting the `SET` list is what stops a write from clobbering columns it was never
 * given. Placeholders are numbered by hand, the shape `buildProjectListQuery` and
 * `lib/audit/admin.ts` use; every caller value is bound, never interpolated.
 */
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
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };

  const sets: string[] = [];
  if (patch.slug !== undefined) sets.push(`slug = ${bind(patch.slug)}`);
  if (patch.name !== undefined) sets.push(`name = ${bind(patch.name)}`);
  if (patch.description !== undefined) sets.push(`description = ${bind(patch.description)}`);
  if (patch.category !== undefined) sets.push(`category = ${bind(patch.category)}`);
  if (patch.stack !== undefined) sets.push(`stack = ${bind(String(patch.stack))}::"Stack"`);
  if (patch.prompt !== undefined) sets.push(`prompt = ${bind(patch.prompt)}`);
  if (patch.designDirection !== undefined) {
    sets.push(`"designDirection" = ${bind(patch.designDirection)}`);
  }
  if (patch.thumbnailKey !== undefined) sets.push(`"thumbnailKey" = ${bind(patch.thumbnailKey)}`);
  if (patch.previewUrl !== undefined) sets.push(`"previewUrl" = ${bind(patch.previewUrl)}`);
  if (patch.isActive !== undefined) sets.push(`"isActive" = ${bind(patch.isActive)}`);
  if (patch.isBuiltIn !== undefined) sets.push(`"isBuiltIn" = ${bind(patch.isBuiltIn)}`);
  if (patch.workspaceId !== undefined) sets.push(`"workspaceId" = ${bind(patch.workspaceId)}`);
  if (patch.sortOrder !== undefined) sets.push(`"sortOrder" = ${bind(patch.sortOrder)}`);

  // Nothing to write. Answering with the stored row keeps "no such template" → null.
  if (sets.length === 0) return findTemplateById(id);

  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `UPDATE "Template" SET ${sets.join(', ')}
     WHERE id = ${bind(id)}
     RETURNING id, slug, name, description, category, stack, prompt, "designDirection",
       "thumbnailKey", "previewUrl", "isActive", "isBuiltIn", "workspaceId",
       "createdById", "usageCount", "sortOrder", "createdAt"`,
    ...values,
  );
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
