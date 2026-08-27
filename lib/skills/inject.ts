import { prisma } from '@/lib/db';
import { SKILL_MARKER_PREFIX } from '@/lib/generation/output-summary';
import { log } from '@/lib/logger';
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
    // Nothing ever asked for it, but a live build answered with `Skill: Landing page
    // structure` / `Skill: Form UX` on their own lines — the model echoing the headings
    // below in the one syntax the workspace reserves for its own chips. The workspace
    // already shows which skills applied (`ChatPanel`, from `metadata.skillNames`), so
    // the echo was pure duplication in the customer's transcript. The route strips it
    // either way; this is the half that stops it being generated. `SKILL_MARKER_PREFIX`
    // is imported rather than spelled out so the ask and the strip cannot drift.
    `Never name or announce these skills in your reply, and never write a line beginning "${SKILL_MARKER_PREFIX}" — the workspace already shows the user which skills applied.`,
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
  userId: string | null = null,
): Promise<InjectedSkills> {
  const empty: InjectedSkills = { block: '', names: [], skills: [] };
  try {
    const matched = await selectSkills(
      userMessage,
      projectContext,
      { listEnabled: listEnabledForMatch },
      userId,
    );
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
  } catch (error) {
    // Skills must never fail a generation, so this stays non-throwing. It used to
    // be a bare `catch {}`, which meant a ranker 429, a Zod parse miss or a blip
    // on `skill.findMany` made the whole feature vanish: no skill block, no
    // `skills` progress event, `usageCount` flat on /admin/usage, and nothing to
    // look at when an admin reported "my skill never applies".
    log.warn('skills.injection_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return empty;
  }
}
