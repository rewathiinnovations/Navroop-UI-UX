import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DESIGN_DIRECTION,
  DESIGN_DIRECTION_IDS,
  DESIGN_DIRECTIONS,
  INTERFACE_QUALITY_BAR,
  getDirection,
  isDesignDirectionId,
  resolveDirectionId,
  toPromptBlock,
} from '@/lib/design/directions';

describe('design directions are complete and typed strongly', () => {
  it('every id is coverable, resolves, and has the full spec fields', () => {
    for (const id of DESIGN_DIRECTION_IDS) {
      expect(DESIGN_DIRECTIONS[id]).toBeDefined();
      expect(isDesignDirectionId(id)).toBe(true);
      const direction = getDirection(id);
      expect(direction.id).toBe(id);
      expect(direction.label).toBeTruthy();
      expect(direction.fontPairing).toBeTruthy();
      expect(direction.radiusScale).toBeTruthy();
      expect(direction.spacingScale).toBeTruthy();
      expect(direction.colorGuidance).toBeTruthy();
      expect(direction.toneWords.length).toBeGreaterThan(0);
    }
  });

  it('an unknown id falls back to the default, never to array position', () => {
    expect(resolveDirectionId('nonsense')).toBe(DEFAULT_DESIGN_DIRECTION);
    expect(isDesignDirectionId('nonsense')).toBe(false);
    expect(getDirection('nonsense').id).toBe(DEFAULT_DESIGN_DIRECTION);
  });
});

describe('the prompt block carries the quality floor and direction-specific guards', () => {
  it('includes the shared interface quality bar for every direction', () => {
    for (const id of DESIGN_DIRECTION_IDS) {
      const block = toPromptBlock(getDirection(id));
      expect(block).toContain('INTERFACE QUALITY FLOOR');
      expect(block).toContain('prefers-reduced-motion');
      expect(block).toContain('Never \'transition: all\'');
      expect(block).toContain('Zero em-dashes');
      expect(block).toContain('Iconography: Lucide or Heroicons only. Never emoji as icons.');
    }
  });

  it('each direction declares a signature element and avoidance traps', () => {
    for (const id of DESIGN_DIRECTION_IDS) {
      const direction = getDirection(id);
      expect(direction.signature).toBeTruthy();
      expect(direction.avoidTraps.length).toBeGreaterThan(0);
      const block = toPromptBlock(direction);
      expect(block).toContain('Signature element');
      expect(block).toContain('Avoid:');
    }
  });

  it('the quality bar text is exported and non-empty', () => {
    expect(INTERFACE_QUALITY_BAR).toContain('INTERFACE QUALITY FLOOR');
    expect(INTERFACE_QUALITY_BAR.length).toBeGreaterThan(400);
  });

  it('does not use em-dashes in the generated block (taste-skill zero-em-dash rule)', () => {
    for (const id of DESIGN_DIRECTION_IDS) {
      const block = toPromptBlock(getDirection(id));
      expect(block).not.toMatch(/[\u2014\u2013]/);
    }
  });
});
