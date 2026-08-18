/**
 * Two-level Brain memory: render/cap, extract helpers, cacheable prefix.
 * Run: pnpm exec tsx tests/memory.test.ts
 */
import { buildStablePromptPrefix } from '../lib/stack-prompts';
import { estimateTokens } from '../lib/generation/token-estimate';
import {
  MEMORY_CATEGORIES,
  MEMORY_TOKEN_BUDGET,
  type MemoryRecord,
} from '../lib/memory/types';
import { createMemoryInputSchema, memoryContentSchema } from '../lib/memory/schema';
import { isDuplicateMemory, normalizeMemoryContent } from '../lib/memory/normalize';
import { renderMemoryBlock } from '../lib/memory/build-context';
import {
  extractMemoriesAfterGeneration,
  parseExtractedMemories,
} from '../lib/memory/extract';

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

function entry(partial: Partial<MemoryRecord> & Pick<MemoryRecord, 'id' | 'content'>): MemoryRecord {
  return {
    scope: 'PROJECT',
    projectId: 'p1',
    category: 'design',
    source: 'manual',
    status: 'ACTIVE',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    ...partial,
  };
}

assert(memoryContentSchema.safeParse('').success === false, 'content rejects empty');
assert(memoryContentSchema.safeParse('x'.repeat(501)).success === false, 'content rejects over 500');
assert(memoryContentSchema.safeParse('always use Inter').success === true, 'content accepts 1-500');
assert(createMemoryInputSchema.safeParse({
  scope: 'WORKSPACE',
  category: 'branding',
  content: 'use Inter',
}).success === false, 'category rejects unknown values');
assert(
  MEMORY_CATEGORIES.join(',') === 'design,tech,content,context',
  'categories are design|tech|content|context',
);

assert(normalizeMemoryContent('  Always   USE Inter  ') === 'always use inter', 'normalize trims and lowercases');
assert(
  isDuplicateMemory('Always use Inter', ['always use inter', 'prefer next.js']),
  'duplicate matches normalized ACTIVE content',
);
assert(
  isDuplicateMemory('use Georgia', ['always use inter']) === false,
  'non-matching content is not a duplicate',
);

const parsed = parseExtractedMemories(JSON.stringify([
  { category: 'design', content: 'use Inter', scope: 'WORKSPACE' },
  { category: 'tech', content: 'prefer server components', scope: 'PROJECT' },
  { category: 'content', content: 'brand is Harbor', scope: 'PROJECT' },
  { category: 'context', content: 'audience is bakers', scope: 'PROJECT' },
  { category: 'design', content: 'fifth should drop', scope: 'PROJECT' },
]));
assert(parsed.length === 3, 'extraction caps at 3 proposals');
assert(parsed.every((row) => row.scope === 'PROJECT'), 'extraction forces PROJECT scope only');
assert(parsed[0]?.content === 'use Inter', 'keeps first valid proposal content');
assert(parseExtractedMemories('not-json').length === 0, 'invalid extraction JSON yields empty');
assert(parseExtractedMemories(JSON.stringify([{ category: 'nope', content: 'x' }])).length === 0, 'invalid category dropped');

const empty = renderMemoryBlock([]);
assert(empty.block === '', 'no ACTIVE entries yields empty block');
assert(empty.truncated === false, 'empty block is not truncated');
assert(empty.tokenEstimate === 0, 'empty block token estimate is 0');

const mixed = renderMemoryBlock([
  entry({
    id: 'pending',
    content: 'should never inject',
    status: 'PENDING',
    source: 'extracted',
    createdAt: new Date('2026-08-16T12:00:00.000Z'),
  }),
  entry({
    id: 'ws-design',
    scope: 'WORKSPACE',
    projectId: null,
    category: 'design',
    content: 'always use Inter for body text',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  }),
  entry({
    id: 'proj-old',
    category: 'tech',
    content: 'older project rule',
    createdAt: new Date('2026-08-02T00:00:00.000Z'),
  }),
  entry({
    id: 'proj-new',
    category: 'tech',
    content: 'newer project rule',
    createdAt: new Date('2026-08-10T00:00:00.000Z'),
  }),
]);
assert(mixed.block.includes('always use Inter for body text'), 'workspace ACTIVE content is included');
assert(mixed.block.includes('newer project rule'), 'project ACTIVE content is included');
assert(!mixed.block.includes('should never inject'), 'PENDING extracted is not injected');
assert(
  mixed.block.indexOf('always use Inter for body text') < mixed.block.indexOf('newer project rule'),
  'workspace section renders before project',
);
assert(
  mixed.block.indexOf('newer project rule') < mixed.block.indexOf('older project rule'),
  'project entries render newest-first',
);
assert(!mixed.block.toLowerCase().includes('landing page structure'), 'skill content is not in the memory block');

const again = renderMemoryBlock([
  entry({
    id: 'ws-design',
    scope: 'WORKSPACE',
    projectId: null,
    category: 'design',
    content: 'always use Inter for body text',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  }),
  entry({
    id: 'proj-old',
    category: 'tech',
    content: 'older project rule',
    createdAt: new Date('2026-08-02T00:00:00.000Z'),
  }),
  entry({
    id: 'proj-new',
    category: 'tech',
    content: 'newer project rule',
    createdAt: new Date('2026-08-10T00:00:00.000Z'),
  }),
]);
assert(mixed.block === again.block, 'same memory set is byte-identical');

const long = 'Keep this durable preference about typography and spacing for the generated site. '.repeat(4);
const many: MemoryRecord[] = [];
for (let i = 0; i < 12; i += 1) {
  many.push(entry({
    id: `ws-${i}`,
    scope: 'WORKSPACE',
    projectId: null,
    category: 'context',
    content: `${long} workspace ${i}`,
    createdAt: new Date(Date.UTC(2026, 7, 1, 0, i)),
  }));
}
for (let i = 0; i < 40; i += 1) {
  many.push(entry({
    id: `p-${i}`,
    category: 'content',
    content: `${long} project ${i}`,
    createdAt: new Date(Date.UTC(2026, 7, 2, 0, i)),
  }));
}
const capped = renderMemoryBlock(many);
assert(capped.truncated === true, '50+ entries truncate at the token budget');
assert(capped.tokenEstimate <= MEMORY_TOKEN_BUDGET, 'rendered block stays at or under 1500 tokens');
assert(capped.block.includes('workspace 11'), 'workspace entries are kept first when truncating');
assert(!capped.block.includes('project 0'), 'oldest project entries can be dropped to fit the budget');
assert(estimateTokens(capped.block) <= MEMORY_TOKEN_BUDGET, 'estimateTokens agrees with the cap');

const prefixA = buildStablePromptPrefix('NEXTJS', 'minimal', { memoryBlock: mixed.block });
const prefixB = buildStablePromptPrefix('NEXTJS', 'minimal', { memoryBlock: again.block });
assert(prefixA === prefixB, 'same project+memory set yields a byte-identical stable prefix');
assert(prefixA.includes(mixed.block), 'memory sits inside the stable prefix');
assert(prefixA.indexOf('QUALITY (every file)') < prefixA.indexOf('Brain memory'), 'memory comes after base-rules');
assert(!prefixA.includes('You are the user'), 'volatile user message is not in the stable prefix');

let completeCalls = 0;
const extracted = await extractMemoriesAfterGeneration('p1', { sourceMessage: 'always use Inter' }, {
  isEnabled: async () => true,
  listActiveContents: async () => ['always use inter'],
  complete: async () => {
    completeCalls += 1;
    return JSON.stringify([{ category: 'design', content: 'always use Inter', scope: 'PROJECT' }]);
  },
  insertPending: async () => {
    throw new Error('should not insert duplicates');
  },
});
assert(extracted.inserted === 0, 'deduped extraction inserts nothing');
assert(completeCalls === 1, 'enabled extraction still calls the model');

const skipped = await extractMemoriesAfterGeneration('p1', { sourceMessage: 'always use Inter' }, {
  isEnabled: async () => false,
  complete: async () => {
    throw new Error('must not run when disabled');
  },
  insertPending: async () => {
    throw new Error('must not insert when disabled');
  },
});
assert(skipped.inserted === 0, 'disabled extraction does not run');

const swallowed = await extractMemoriesAfterGeneration('p1', { sourceMessage: 'prefer dark UI' }, {
  isEnabled: async () => true,
  listActiveContents: async () => [],
  complete: async () => {
    throw new Error('model down');
  },
  insertPending: async () => {
    throw new Error('must not insert after throw');
  },
});
assert(swallowed.inserted === 0, 'extraction failure is swallowed');
assert(swallowed.ok === true, 'extraction failure does not fail the build hook');

const inserted = await extractMemoriesAfterGeneration('p1', { sourceMessage: 'prefer dark UI' }, {
  isEnabled: async () => true,
  listActiveContents: async () => [],
  complete: async () => JSON.stringify([
    { category: 'design', content: 'prefer dark UI', scope: 'PROJECT' },
    { category: 'tech', content: 'use CSS variables', scope: 'PROJECT' },
  ]),
  insertPending: async (rows) => {
    assert(rows.length === 2, 'inserts non-duplicate extracted rows');
    assert(rows.every((row) => row.status === 'PENDING'), 'extracted rows are PENDING');
    assert(rows.every((row) => row.source === 'extracted'), 'extracted rows are source extracted');
    assert(rows.every((row) => row.scope === 'PROJECT'), 'extracted rows stay PROJECT');
  },
});
assert(inserted.inserted === 2, 'inserts up to three new PENDING proposals');

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
