export type MockOutcome = 'success' | 'failure' | 'timeout' | 'rate_limit' | 'partial';

export function createAiMock(outcome: MockOutcome = 'success') {
  let invoked = 0;
  return {
    get invoked() {
      return invoked;
    },
    async complete(prompt: string) {
      invoked += 1;
      if (outcome === 'failure') throw new Error('AI provider failed');
      if (outcome === 'timeout') {
        const error = new Error('AI provider timeout');
        (error as Error & { code?: string }).code = 'ETIMEDOUT';
        throw error;
      }
      if (outcome === 'rate_limit') {
        const error = new Error('rate limit') as Error & { status: number };
        error.status = 429;
        throw error;
      }
      if (outcome === 'partial') {
        return { text: `<file path="src/App.tsx">export default function App(){return null}`, truncated: true, prompt };
      }
      return {
        text: `<file path="src/App.tsx">export default function App(){return null}</file>`,
        truncated: false,
        prompt,
      };
    },
  };
}
