/**
 * The `mine` query parameter and the Owner select, in both directions.
 *
 * `mine` has always had three states: `true` (only mine), `false` (only projects
 * shared with me), and absent (everything). `components/layout/Sidebar.tsx` links
 * to `/projects?mine=false` under the label "Shared with me".
 *
 * The select modelled two of them — `value={mine === true ? 'mine' : 'all'}`, with
 * `onChange` mapping anything but `'mine'` to `undefined`. Arriving from the
 * sidebar link therefore applied the filter while the control read "All", and the
 * first touch of the control silently dropped it, with no way to get it back from
 * the page. The property these two functions hold is the round trip:
 * `ownerFilterFor(mineFromOwnerFilter(value)) === value`.
 */
export type OwnerFilter = 'all' | 'mine' | 'shared';

export const OWNER_FILTER_LABELS: Record<OwnerFilter, string> = {
  all: 'All',
  mine: 'Just mine',
  shared: 'Shared with me',
};

/** The `?mine=` value as the list request and the select both need it. */
export function parseMine(value: string | null): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** Which option the select shows for the filter currently applied. */
export function ownerFilterFor(mine: boolean | undefined): OwnerFilter {
  if (mine === true) return 'mine';
  if (mine === false) return 'shared';
  return 'all';
}

/** The filter a picked option applies. */
export function mineFromOwnerFilter(value: string): boolean | undefined {
  if (value === 'mine') return true;
  if (value === 'shared') return false;
  return undefined;
}
