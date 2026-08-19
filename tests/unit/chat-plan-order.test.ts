/**
 * The plan card sits where it happened in the conversation.
 *
 * It used to be rendered after the whole message list, so a follow-up sent hours
 * later ("can you add images") appeared *above* an APPROVED plan and the plan read
 * as the newest thing in the thread — which is what the user photographed.
 *
 * Rendered through `react-dom/server` like the other workspace view tests, so the
 * assertions are about output order rather than component internals.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import ChatPanel from '@/components/workspace/ChatPanel';
import type { ChatMessage } from '@/lib/generation/types';
import type { WorkspacePlan } from '@/components/workspace/types';

const PLAN_AT = new Date('2026-08-19T12:00:00.000Z');

function message(content: string, minutesFromPlan: number): ChatMessage {
  return {
    content,
    type: 'user',
    timestamp: new Date(PLAN_AT.getTime() + minutesFromPlan * 60_000),
  };
}

const PLAN: WorkspacePlan = {
  id: 'plan_1',
  version: 1,
  status: 'APPROVED',
  trigger: 'initial',
  sourceMessage: 'Build a dealership landing page',
  createdAt: PLAN_AT.toISOString(),
  content: {
    summary: 'PLAN_SUMMARY_MARKER',
    pages: [{ name: 'Home', description: 'One scroll route' }],
    keyFeatures: ['Trust strip'],
  },
};

function render(messages: ChatMessage[], plan: WorkspacePlan | null = PLAN) {
  return renderToStaticMarkup(
    createElement(ChatPanel, { messages, projectId: 'p1', plan, phase: 'COMPLETE' }),
  );
}

/** Where each marker lands in the rendered output. */
function positions(html: string, ...markers: string[]) {
  return markers.map((marker) => html.indexOf(marker));
}

describe('plan card ordering in the chat', () => {
  it('renders the plan before a message sent after it', () => {
    const html = render([
      message('Build a dealership landing page', -1),
      message('can you add images', 120),
    ]);

    const [plan, laterMessage] = positions(html, 'PLAN_SUMMARY_MARKER', 'can you add images');
    expect(plan).toBeGreaterThan(-1);
    expect(laterMessage).toBeGreaterThan(-1);
    expect(plan).toBeLessThan(laterMessage);
  });

  it('renders the plan after the message that prompted it', () => {
    const html = render([message('Build a dealership landing page', -1)]);

    const [prompt, plan] = positions(
      html,
      'Build a dealership landing page',
      'PLAN_SUMMARY_MARKER',
    );
    expect(prompt).toBeLessThan(plan);
  });

  it('renders the card exactly once', () => {
    // The obvious implementation renders it inside the loop *and* after it, so the
    // normal case — a plan drafted from the newest message — showed two cards.
    const html = render([message('Build a dealership landing page', -1)]);

    expect(html.split('PLAN_SUMMARY_MARKER').length - 1).toBe(1);
  });

  it('renders it once when it is newer than every message', () => {
    const html = render([message('older chatter', -30), message('still older', -10)]);

    expect(html.split('PLAN_SUMMARY_MARKER').length - 1).toBe(1);
  });

  it('puts a plan older than the whole thread at the top', () => {
    // A reopened project whose messages were all written after the plan.
    const html = render([message('first thing after reopening', 5)]);

    const [plan, firstMessage] = positions(
      html,
      'PLAN_SUMMARY_MARKER',
      'first thing after reopening',
    );
    expect(plan).toBeLessThan(firstMessage);
  });

  it('renders nothing extra when there is no plan', () => {
    const html = render([message('hello', 0)], null);

    expect(html).not.toContain('PLAN_SUMMARY_MARKER');
    expect(html).toContain('hello');
  });

  it('still shows the card when the timestamp is unusable', () => {
    // A missing or malformed createdAt must never hide an approved plan.
    const html = render([message('hello', 0)], { ...PLAN, createdAt: 'not-a-date' });

    expect(html.split('PLAN_SUMMARY_MARKER').length - 1).toBe(1);
  });
});
