import { prisma } from '@/lib/db';
import { selectSkills, type MatchedSkill } from './match';

export type InjectedSkills = {
  block: string;
  names: string[];
  skills: MatchedSkill[];
};

export function buildSkillInjectionBlock(skills: { name: string; content: string }[]): string {
  if (skills.length === 0) return '';
  return [
    '## Active workspace skills',
    'Apply these instruction sets for this request only. They are conditional and must not be treated as always-on Brain memory.',
    ...skills.map((skill) => `### ${skill.name}\n${skill.content}`),
  ].join('\n\n');
}

async function listEnabledForMatch() {
  const rows = await prisma.skill.findMany({
    where: { enabled: true },
    select: { id: true, name: true, description: true, enabled: true, updatedAt: true },
  });
  return rows;
}

/** Load matched skill content, increment usage, return a volatile injection block. Never throws. */
export async function injectMatchedSkills(
  userMessage: string,
  projectContext = '',
): Promise<InjectedSkills> {
  const empty: InjectedSkills = { block: '', names: [], skills: [] };
  try {
    const matched = await selectSkills(userMessage, projectContext, {
      listEnabled: listEnabledForMatch,
    });
    if (matched.length === 0) return empty;

    const rows = await prisma.skill.findMany({
      where: { id: { in: matched.map((skill) => skill.id) }, enabled: true },
      select: { id: true, name: true, content: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const injectedIds: string[] = [];
    const ordered = matched.flatMap((skill) => {
      const row = byId.get(skill.id);
      if (!row) return [];
      injectedIds.push(row.id);
      return [{ name: row.name, content: row.content }];
    });
    if (ordered.length === 0) return empty;

    await prisma.skill.updateMany({
      where: { id: { in: injectedIds } },
      data: { usageCount: { increment: 1 } },
    });

    return {
      block: buildSkillInjectionBlock(ordered),
      names: ordered.map((skill) => skill.name),
      skills: matched.slice(0, ordered.length),
    };
  } catch {
    return empty;
  }
}
