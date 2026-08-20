/**
 * The AI double is the only one left here.
 *
 * F-604/F-605: this barrel also exported `createGithubMock`, `createCoolifyMock`,
 * `createCloudflareMock`, `createResendMock`, `createSentryMock` and
 * `createStorageMock`. Nothing in `tests/` or `e2e/` imported any of them except
 * `tests/unit/mocks.test.ts`, which existed to exercise them — 145 lines of mock and
 * 79 lines of test that only tested each other. The suites that need provider doubles
 * build their own instead, on purpose: `tests/integration/publish-execute.test.ts`
 * assembles a complete `PublishDeps` bundle so a missing method is a type error rather
 * than a silently absent stub, which a shared partial mock cannot give it.
 *
 * `createAiMock` stays because it has a real consumer: `tests/unit/money-limits.test.ts`
 * uses it to prove an exhausted workspace is refused before the provider is called.
 */
export { createAiMock, type MockOutcome } from './ai';
