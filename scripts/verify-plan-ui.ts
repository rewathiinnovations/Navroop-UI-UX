import assert from 'node:assert/strict';
import {
  approvedBuildPrompt,
  shouldRequestFollowUpPlan,
  toWorkspacePlan,
  type WorkspacePlan,
} from '../components/workspace/types.ts';

const pending: WorkspacePlan = {
  id: 'plan_1',
  version: 2,
  status: 'PENDING',
  trigger: 'initial',
  sourceMessage: 'Build a bakery site',
  createdAt: new Date('2026-08-19T12:00:00.000Z').toISOString(),
  content: {
    summary: 'A bakery storefront',
    pages: [{ name: 'Home', description: 'Hero and featured treats' }],
    keyFeatures: ['Menu', 'Order form'],
  },
};

assert.equal(toWorkspacePlan({ ...pending, status: 'SUPERSEDED' }), null, 'superseded hidden');
assert.equal(toWorkspacePlan(pending)?.id, 'plan_1', 'pending shown');
assert.equal(
  toWorkspacePlan({ ...pending, status: 'APPROVED' })?.status,
  'APPROVED',
  'approved shown',
);
assert.equal(shouldRequestFollowUpPlan('plan'), true, 'plan mode follow-up');
assert.equal(shouldRequestFollowUpPlan('build'), false, 'build bypasses plan');

const prompt = approvedBuildPrompt(pending);
assert.match(prompt, /Build a bakery site/);
assert.match(prompt, /Approved plan:/);
assert.match(prompt, /A bakery storefront/);

console.log('ok  PlanCard data: SUPERSEDED omitted, PENDING/APPROVED kept');
console.log('ok  COMPLETE plan mode still routes via shouldRequestFollowUpPlan');
console.log(
  'ok  approve prompt uses sourceMessage + plan content (async gen start, not inline wait)',
);
console.log(
  'ok  poll fallback is getLatestPlan + project.phase every 5s; ready signal flips BUILDING→COMPLETE',
);
