/**
 * Workspace Skills: matching, injection placement, validation.
 * Run: pnpm exec tsx tests/skills.test.ts
 */
import { buildStablePromptPrefix } from '../lib/stack-prompts';
import { skillInputSchema } from '../lib/skills/schema.ts';
import { DEFAULT_SKILLS } from '../lib/skills/defaults.ts';
import {
  selectSkills,
  runWithSkillMatchCache,
  resetSkillMatchCacheForTests,
} from '../lib/skills/match.ts';
import { buildSkillInjectionBlock } from '../lib/skills/inject.ts';
import type { SkillMatchCandidate, SkillRanker } from '../lib/skills/match.ts';

let failed = 0;
let passed = 0;

function assert(cond: unknown, name: string) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
}

function candidate(
  partial: Partial<SkillMatchCandidate> & Pick<SkillMatchCandidate, 'id' | 'name' | 'description'>,
): SkillMatchCandidate {
  return {
    enabled: true,
    updatedAt: 'v1',
    ...partial,
  };
}

const landing = candidate({
  id: 'landing',
  name: 'Landing page structure',
  description:
    'When building a marketing, landing, pricing, homepage, or conversion-focused page with a hero or CTA',
});
const form = candidate({
  id: 'form',
  name: 'Form UX',
  description: 'When adding or editing a form, fields, validation, or submit flow',
});
const table = candidate({
  id: 'table',
  name: 'Data table UX',
  description: 'When building a data table, sortable rows, pagination, or grid of records',
});
const dash = candidate({
  id: 'dash',
  name: 'Dashboard layout',
  description: 'When building a dashboard with metrics, widgets, filters, or summary cards',
});

const extra = candidate({
  id: 'extra',
  name: 'Checkout flow',
  description: 'When building checkout, cart, or payment steps on a pricing or landing page',
});

function listOf(skills: SkillMatchCandidate[]) {
  return async () => skills.filter((skill) => skill.enabled);
}

{
  const ok = skillInputSchema.safeParse({
    name: 'Landing page structure',
    description: 'When building a landing page',
    content: 'Use a single CTA.',
  });
  assert(ok.success, 'accepts valid skill fields');

  const nameLong = skillInputSchema.safeParse({
    name: 'x'.repeat(61),
    description: 'When',
    content: 'Do',
  });
  assert(!nameLong.success, 'rejects name over 60 chars');

  const descLong = skillInputSchema.safeParse({
    name: 'Ok',
    description: 'd'.repeat(201),
    content: 'Do',
  });
  assert(!descLong.success, 'rejects description over 200 chars');

  const contentLong = skillInputSchema.safeParse({
    name: 'Ok',
    description: 'When',
    content: 'c'.repeat(4001),
  });
  assert(!contentLong.success, 'rejects content over 4000 chars');

  const empty = skillInputSchema.safeParse({ name: '', description: '', content: '' });
  assert(!empty.success, 'rejects empty name/description/content');
}

{
  assert(DEFAULT_SKILLS.length === 4, 'seeds four default skills');
  assert(
    DEFAULT_SKILLS.some((skill) => skill.name === 'Landing page structure'),
    'includes Landing page structure',
  );
  assert(DEFAULT_SKILLS.some((skill) => skill.name === 'Form UX'), 'includes Form UX');
  assert(DEFAULT_SKILLS.some((skill) => skill.name === 'Data table UX'), 'includes Data table UX');
  assert(DEFAULT_SKILLS.some((skill) => skill.name === 'Dashboard layout'), 'includes Dashboard layout');
  const landingSeed = DEFAULT_SKILLS.find((skill) => skill.name === 'Landing page structure');
  assert(landingSeed?.content.toLowerCase().includes('hero'), 'landing content mentions hero');
  assert(landingSeed?.content.includes('FAQ'), 'landing content mentions FAQ');
  const formSeed = DEFAULT_SKILLS.find((skill) => skill.name === 'Form UX');
  assert(formSeed?.content.includes('blur'), 'form content mentions blur validation');
}

{
  const ranker: SkillRanker = async () => {
    throw new Error('ranker should not run with 3 or fewer enabled skills');
  };
  const matched = await selectSkills('build a pricing page', '', {
    listEnabled: listOf([landing, form, table]),
    ranker,
  });
  assert(matched.length === 1, 'pricing page matches one skill via keywords');
  assert(matched[0]?.id === 'landing', 'pricing page injects the landing-page skill');
}

{
  const ranker: SkillRanker = async () => {
    throw new Error('ranker should not run with 3 or fewer enabled skills');
  };
  const matched = await selectSkills('fix the button color', '', {
    listEnabled: listOf([landing, form, table]),
    ranker,
  });
  assert(matched.length === 0, 'button color injects none');
}

{
  let rankerCalls = 0;
  const ranker: SkillRanker = async ({ skills, userMessage }) => {
    rankerCalls += 1;
    assert(
      skills.every((skill) => !('content' in skill) || (skill as { content?: string }).content == null),
      'cheap model receives name+description only',
    );
    assert(userMessage.includes('pricing'), 'cheap model receives the user message');
    return [
      { id: 'landing', confidence: 0.9 },
      { id: 'extra', confidence: 0.8 },
      { id: 'form', confidence: 0.7 },
    ];
  };
  const matched = await selectSkills('build a pricing page', 'marketing site', {
    listEnabled: listOf([landing, form, table, extra]),
    ranker,
  });
  assert(rankerCalls === 1, 'more than 3 enabled skills uses the cheap model');
  assert(matched.length === 2, 'caps matches at 2');
  assert(matched[0]?.id === 'landing' && matched[1]?.id === 'extra', 'keeps the two highest-confidence skills');
}

{
  const ranker: SkillRanker = async () => {
    throw new Error('model down');
  };
  const matched = await selectSkills('build a pricing page', '', {
    listEnabled: listOf([landing, form, table, extra]),
    ranker,
  });
  assert(matched.length === 0, 'matching failure returns [] and does not throw');
}

{
  const disabledLanding = { ...landing, enabled: false };
  const matched = await selectSkills('build a pricing page', '', {
    listEnabled: listOf([disabledLanding, form, table]),
  });
  assert(
    matched.every((skill) => skill.id !== 'landing'),
    'disabled skills stop matching immediately',
  );
}

{
  resetSkillMatchCacheForTests();
  let rankerCalls = 0;
  const ranker: SkillRanker = async () => {
    rankerCalls += 1;
    return [{ id: 'landing', confidence: 0.95 }];
  };
  const deps = {
    listEnabled: listOf([landing, form, table, extra]),
    ranker,
  };
  await runWithSkillMatchCache(async () => {
    const first = await selectSkills('build a pricing page', '', deps);
    const second = await selectSkills('build a pricing page', '', deps);
    assert(rankerCalls === 1, 'caches match per message + skill-set version for the request');
    assert(first[0]?.id === second[0]?.id, 'cached retry returns the same match');
  });
}

{
  const block = buildSkillInjectionBlock([
    { name: 'Landing page structure', content: 'Use one primary CTA.' },
  ]);
  assert(block.includes('Landing page structure'), 'injection names the skill');
  assert(block.includes('Use one primary CTA.'), 'injection includes skill content');
  const prefix = buildStablePromptPrefix('NEXTJS', 'minimal');
  assert(!prefix.includes('Use one primary CTA.'), 'skill content is not inside the cacheable prefix');
  assert(
    prefix === buildStablePromptPrefix('NEXTJS', 'minimal'),
    'stable prefix stays byte-identical with or without a skill',
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
