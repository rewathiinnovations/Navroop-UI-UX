import type { PlanContent } from '@/lib/projects/plan';

export function buildTemplatePromptFromProject(input: {
  initialPrompt: string;
  plan?: PlanContent | null;
  stack: string;
  designDirection: string;
}) {
  const original = input.initialPrompt.replace(/\s+/g, ' ').trim();
  const plan = input.plan;
  const pages = plan?.pages?.map((page) => `${page.name}: ${page.description}`).join(' ') || '';
  const features = plan?.keyFeatures?.join('; ') || '';
  const summary = plan?.summary?.trim() || '';

  const parts = [
    original,
    summary ? `Approved plan summary: ${summary}` : '',
    pages ? `Pages in order: ${pages}` : '',
    features ? `Key features: ${features}` : '',
    `Use the ${input.stack} stack and the ${input.designDirection} design direction.`,
    'Keep placeholder names, addresses, and phone numbers in an Indian context. Do not use Lorem ipsum.',
  ].filter(Boolean);

  return parts.join('\n\n');
}
