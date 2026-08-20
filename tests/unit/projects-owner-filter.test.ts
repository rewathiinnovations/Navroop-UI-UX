import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OWNER_FILTER_LABELS,
  mineFromOwnerFilter,
  ownerFilterFor,
  parseMine,
  type OwnerFilter,
} from '@/app/(app)/projects/owner-filter';

/**
 * F-427. `?mine=` has three states and the Owner select modelled two:
 * `value={mine === true ? 'mine' : 'all'}`, with `onChange` mapping anything but
 * `'mine'` to `undefined`. Arriving from the sidebar's "Shared with me" link
 * (`/projects?mine=false`) the filter was applied while the control read "All",
 * and the first touch of the control silently dropped it with no way to get it
 * back from the page.
 *
 * The invariant is the round trip between the applied filter and the shown option.
 */
describe('the projects Owner filter', () => {
  const options: OwnerFilter[] = ['all', 'mine', 'shared'];

  it('shows an option for every state ?mine= can be in', () => {
    expect(options.map((option) => mineFromOwnerFilter(option))).toEqual([undefined, true, false]);
  });

  it('round-trips every option through the applied filter', () => {
    for (const option of options) {
      expect(ownerFilterFor(mineFromOwnerFilter(option))).toBe(option);
    }
  });

  /** The exact regression: `mine === false` used to display as "All". */
  it('shows "Shared with me" for the filter the sidebar link applies', () => {
    expect(parseMine('false')).toBe(false);
    expect(ownerFilterFor(false)).toBe('shared');
    expect(OWNER_FILTER_LABELS.shared).toBe('Shared with me');
  });

  /** And picking it used to drop the filter rather than re-apply it. */
  it('re-applies the shared filter when the option is picked', () => {
    expect(mineFromOwnerFilter('shared')).toBe(false);
  });

  it('treats an unknown ?mine= value and an unknown option as no filter', () => {
    expect(parseMine(null)).toBeUndefined();
    expect(parseMine('yes')).toBeUndefined();
    expect(mineFromOwnerFilter('')).toBeUndefined();
    expect(ownerFilterFor(undefined)).toBe('all');
  });

  /**
   * The label is duplicated in the sidebar, which is where the unreachable state
   * came from in the first place.
   */
  it('uses the same wording as the sidebar link it arrives from', () => {
    const sidebar = readFileSync('components/layout/Sidebar.tsx', 'utf8');
    expect(sidebar).toContain('/projects?mine=false');
    expect(sidebar).toContain(OWNER_FILTER_LABELS.shared);
  });
});
