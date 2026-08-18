import { BUILT_IN_TEMPLATES } from './builtin-templates.mjs';

export { BUILT_IN_TEMPLATES };

export async function seedTemplates(prisma) {
  for (const template of BUILT_IN_TEMPLATES) {
    await prisma.$executeRaw`
      INSERT INTO "Template" (
        id, slug, name, description, category, stack, prompt, "designDirection",
        "isActive", "isBuiltIn", "workspaceId", "usageCount", "sortOrder", "createdAt"
      ) VALUES (
        ${`tmpl_${template.slug}`},
        ${template.slug},
        ${template.name},
        ${template.description},
        ${template.category},
        ${template.stack}::"Stack",
        ${template.prompt},
        ${template.designDirection},
        true,
        true,
        NULL,
        0,
        ${template.sortOrder},
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
        "isActive" = true,
        "sortOrder" = EXCLUDED."sortOrder"
    `;
  }
  console.log(`Seeded ${BUILT_IN_TEMPLATES.length} built-in templates.`);
}
