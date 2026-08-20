import { AsyncLocalStorage } from 'node:async_hooks';
import { generateObject } from 'ai';
import { z } from 'zod';
import { appConfig } from '@/config/app.config';
import { getProviderForModel } from '@/lib/ai/provider-manager';
import { log } from '@/lib/logger';

export type SkillMatchCandidate = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  updatedAt?: Date | string | number;
};

export type MatchedSkill = {
  id: string;
  name: string;
  description: string;
  confidence: number;
};

export type SkillRanker = (input: {
  userMessage: string;
  projectContext: string;
  skills: { id: string; name: string; description: string }[];
  /** Acting user — credential resolution must match the generation call (F-073). */
  userId: string | null;
}) => Promise<{ id: string; confidence: number }[]>;

export type SelectSkillsDeps = {
  listEnabled: () => Promise<SkillMatchCandidate[]>;
  ranker?: SkillRanker;
};

const KEYWORD_SHORT_CIRCUIT = 3;
const MAX_MATCHES = 2;
const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'use',
  'when',
  'build',
  'create',
  'make',
  'add',
  'fix',
  'update',
  'your',
  'you',
  'are',
  'was',
  'not',
]);

const rankSchema = z.object({
  matches: z.array(
    z.object({
      id: z.string(),
      confidence: z.number(),
    }),
  ),
});

const cacheStore = new AsyncLocalStorage<Map<string, MatchedSkill[]>>();

export function runWithSkillMatchCache<T>(fn: () => T): T {
  return cacheStore.run(new Map(), fn);
}

export function resetSkillMatchCacheForTests() {
  /* request cache lives on AsyncLocalStorage only */
}

function getCache() {
  return cacheStore.getStore();
}

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !STOP.has(word)),
  );
}

export function skillSetVersion(skills: SkillMatchCandidate[]): string {
  return skills
    .map((skill) => `${skill.id}:${String(skill.updatedAt ?? '')}:${skill.enabled ? '1' : '0'}`)
    .sort()
    .join('|');
}

export function scoreKeywordOverlap(
  userMessage: string,
  skill: Pick<SkillMatchCandidate, 'name' | 'description'>,
  projectContext = '',
): number {
  const query = tokenize(`${userMessage} ${projectContext}`);
  const hay = tokenize(`${skill.name} ${skill.description}`);
  let overlap = 0;
  for (const token of hay) {
    if (query.has(token)) overlap += 1;
  }
  return overlap;
}

function capMatches(ranked: MatchedSkill[]): MatchedSkill[] {
  return ranked
    .filter((skill) => skill.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_MATCHES);
}

function keywordMatch(
  message: string,
  context: string,
  skills: SkillMatchCandidate[],
): MatchedSkill[] {
  return capMatches(
    skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      confidence: scoreKeywordOverlap(message, skill, context),
    })),
  );
}

export const defaultSkillRanker: SkillRanker = async ({
  userMessage,
  projectContext,
  skills,
  userId,
}) => {
  const { client, actualModel } = await getProviderForModel(appConfig.ai.defaultModel, userId);
  const catalog = skills
    .map((skill) => `- id: ${skill.id}\n  name: ${skill.name}\n  description: ${skill.description}`)
    .join('\n');
  const result = await generateObject({
    model: client(actualModel),
    schema: rankSchema,
    prompt: `Pick which workspace skills apply to this user request.
Return at most 2 matches. Only include skills that clearly apply. Return an empty matches array if none apply.
You are given name and description only — never invent or request full skill content.

Skills:
${catalog}

User message:
${userMessage}

Project context:
${projectContext || '(none)'}`,
  });
  return result.object.matches;
};

export async function selectSkills(
  userMessage: string,
  projectContext = '',
  deps?: SelectSkillsDeps,
  userId: string | null = null,
): Promise<MatchedSkill[]> {
  try {
    if (!deps?.listEnabled) return [];
    const enabled = (await deps.listEnabled()).filter((skill) => skill.enabled);
    if (enabled.length === 0) return [];

    const cacheKey = `${userMessage}\n${projectContext}\n${skillSetVersion(enabled)}`;
    const cache = getCache();
    const cached = cache?.get(cacheKey);
    if (cached) return cached;

    let matched: MatchedSkill[];
    if (enabled.length <= KEYWORD_SHORT_CIRCUIT) {
      matched = keywordMatch(userMessage, projectContext, enabled);
    } else {
      const ranker = deps.ranker ?? defaultSkillRanker;
      const catalog = enabled.map(({ id, name, description }) => ({ id, name, description }));
      const ranked = await ranker({
        userMessage,
        projectContext,
        skills: catalog,
        userId,
      });
      const byId = new Map(enabled.map((skill) => [skill.id, skill]));
      matched = capMatches(
        ranked.flatMap((row) => {
          const skill = byId.get(row.id);
          if (!skill) return [];
          return [
            {
              id: skill.id,
              name: skill.name,
              description: skill.description,
              confidence: row.confidence,
            },
          ];
        }),
      );
    }

    cache?.set(cacheKey, matched);
    return matched;
  } catch (error) {
    // Selection is best-effort by contract — a request with no matched skills is a
    // valid request. The bare `catch {}` this replaces hid the failures that are
    // *not* "nothing matched": a provider 429/500 inside `defaultSkillRanker`, a
    // rankSchema parse miss, a `listEnabled` DB error. Degrade to no skills, but
    // leave evidence.
    log.warn('skills.selection_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
