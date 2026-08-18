/**
 * Chat busy / recovery copy helpers. Run: pnpm exec tsx tests/job-chat-ui.test.ts
 */
import {
  chatPlaceholder,
  isChatBuilding,
  isChatLocked,
} from '../lib/jobs/chat-ui.ts';
import { RECOVERY_HEADING, recoveryCauseLine } from '../lib/jobs/copy.ts';

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

assert(
  isChatBuilding({ phase: 'BUILDING', jobStatus: 'ABANDONED' }) === false,
  'abandoned job is not building even if phase is BUILDING',
);
assert(
  isChatBuilding({ phase: 'BUILDING', jobStatus: 'FAILED' }) === false,
  'failed job is not building even if phase is BUILDING',
);
assert(
  isChatBuilding({ phase: 'BUILDING', jobStatus: 'CANCELLED' }) === false,
  'cancelled job is not building even if phase is BUILDING',
);
assert(
  isChatBuilding({ phase: 'BUILDING', jobStatus: 'SUCCEEDED' }) === false,
  'succeeded job is not building even if phase is BUILDING',
);
assert(
  isChatBuilding({ phase: 'BUILDING', jobStatus: 'RUNNING' }) === true,
  'running job is building',
);
assert(
  isChatBuilding({ phase: 'BUILDING', jobStatus: 'QUEUED' }) === true,
  'queued job is building',
);
assert(
  isChatBuilding({ phase: 'BUILDING', recoveryActive: true }) === false,
  'recovery hides the building indicator',
);
assert(
  isChatBuilding({ phase: 'BUILDING' }) === false,
  'phase BUILDING with no job is not building',
);
assert(
  chatPlaceholder({ phase: 'BUILDING', jobStatus: 'ABANDONED' }) === 'Ask Navroop…',
  'abandoned job unlocks the chat placeholder',
);
assert(
  chatPlaceholder({ phase: 'BUILDING', jobStatus: 'RUNNING' }) === 'Building — hang tight…',
  'running job keeps the building placeholder',
);
assert(
  isChatLocked({ sending: true, phase: 'BUILDING', jobStatus: 'ABANDONED' }) === false,
  'abandoned job unlocks chat even if sending is still true',
);
assert(
  isChatLocked({ sending: true, phase: 'BUILDING', jobStatus: 'FAILED' }) === false,
  'failed job unlocks chat even if sending is still true',
);
assert(
  isChatLocked({ sending: true, phase: 'BUILDING', jobStatus: 'RUNNING' }) === true,
  'running job keeps chat locked',
);
assert(
  isChatLocked({ sending: false, phase: 'BUILDING', recoveryActive: true }) === false,
  'recovery unlocks chat while phase is still BUILDING',
);
assert(recoveryCauseLine(null) !== RECOVERY_HEADING, 'missing cause does not repeat the recovery heading');
assert(recoveryCauseLine(undefined) !== RECOVERY_HEADING, 'undefined cause does not repeat the recovery heading');
assert(recoveryCauseLine('not-a-real-code') !== RECOVERY_HEADING, 'unknown cause does not repeat the recovery heading');
assert(recoveryCauseLine('timeout') === 'The build ran too long', 'known cause still has a distinct line');

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
