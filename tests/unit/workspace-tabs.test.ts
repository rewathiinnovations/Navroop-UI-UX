import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_PRIMARY_TABS,
  WORKSPACE_TABS,
  WORKSPACE_TOOL_TABS,
} from '@/components/workspace/types';

describe('workspace top bar tabs', () => {
  it('keeps Preview and Code as the only labeled primary tabs', () => {
    expect(WORKSPACE_PRIMARY_TABS.map((tab) => tab.id)).toEqual(['preview', 'code']);
  });

  it('keeps Quality, Assets, Brain, and Domains as icon-only tools', () => {
    expect(WORKSPACE_TOOL_TABS.map((tab) => tab.id)).toEqual(['seo', 'assets', 'brain', 'domains']);
  });

  it('lists every workspace view exactly once', () => {
    const ids = WORKSPACE_TABS.map((tab) => tab.id);
    expect(ids).toEqual(['preview', 'code', 'seo', 'assets', 'brain', 'domains']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
