'use client';

import { useEffect, useId, useState } from 'react';
import { ConfirmDialog } from '@/components/admin/ConfirmAction';
import { fetchJson } from '@/lib/notify';
import { formatAdminDateTime } from '../admin/format-admin-date';
import type { PublicDeployment } from '@/lib/publish/types';

/**
 * Pick a previous release of a published site and deploy it (F-264).
 *
 * The release list is the deploy repository's commit history, so there are four
 * mutually exclusive states and none of them may look like another: still
 * loading, GitHub would not answer, only ever published once, and a real list.
 * The old rollback in this product printed a success toast for a redeploy of the
 * broken release — so an empty or unreadable history is said out loud rather than
 * rendered as a list with nothing in it.
 */

type Release = {
  sha: string;
  shortSha: string;
  message: string;
  committedAt: string | null;
  isCurrent: boolean;
};

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; error: string }
  | { kind: 'ready'; releases: Release[]; confirmPhrase: string };
// Locale-pinned, like every other absolute date in the studio (see
// `formatAdminDateTime`): the host locale would otherwise render 8/17 on the
// server and 17/8 in the browser for the same release.
function whenLabel(iso: string | null) {
  if (!iso) return 'date unknown';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'date unknown';
  return formatAdminDateTime(at);
}

export default function RollbackDialog({
  deployment,
  onClose,
  onDone,
}: {
  deployment: PublicDeployment | null;
  onClose: () => void;
  /** Called after a rollback was accepted, so the caller can refetch the table. */
  onDone: (message: string) => void;
}) {
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const groupId = useId();
  const id = deployment?.id ?? null;

  useEffect(() => {
    if (!id) return;
    let live = true;
    setState({ kind: 'loading' });
    setSelected(null);
    void (async () => {
      try {
        const payload = await fetchJson<{ releases: Release[]; confirmPhrase: string }>(
          `/api/deployments/${id}`,
        );
        if (!live) return;
        setState({
          kind: 'ready',
          releases: payload.releases,
          confirmPhrase: payload.confirmPhrase,
        });
        setSelected(payload.releases.find((row) => !row.isCurrent)?.sha ?? null);
      } catch (cause) {
        if (!live) return;
        setState({
          kind: 'error',
          error: cause instanceof Error ? cause.message : 'Could not read the release history',
        });
      }
    })();
    return () => {
      live = false;
    };
  }, [id]);

  if (!deployment) return null;

  const earlier = state.kind === 'ready' ? state.releases.filter((row) => !row.isCurrent) : [];

  const body =
    state.kind === 'loading' ? (
      <p role="status">Reading the release history…</p>
    ) : state.kind === 'error' ? (
      // No "Nothing was deployed" here: the list is a read, so nothing was even
      // attempted. That sentence belongs to a refused rollback, which the dialog
      // prints separately from `onConfirm`.
      <p role="alert" className="text-[var(--studio-danger)]">
        {state.error}
      </p>
    ) : earlier.length === 0 ? (
      <p role="status">
        This site has only ever been published once, so there is no earlier release to go back to.
      </p>
    ) : (
      <div>
        <p>
          Deploys an earlier release of <span className="font-medium">{deployment.slug}</span>. The
          site keeps serving the release you pick until you publish again.
        </p>
        <ul className="mt-12 space-y-8">
          {earlier.map((release) => (
            <li key={release.sha}>
              <label className="flex cursor-pointer items-start gap-8">
                <input
                  type="radio"
                  name={groupId}
                  value={release.sha}
                  checked={selected === release.sha}
                  onChange={() => setSelected(release.sha)}
                  className="mt-4"
                />
                <span>
                  <span className="font-mono text-[13px] text-[var(--studio-fg)]">
                    {release.shortSha}
                  </span>{' '}
                  <span className="text-[13px]">{whenLabel(release.committedAt)}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Roll back to a previous release?"
      body={body}
      confirmLabel="Roll back"
      busyLabel="Rolling back…"
      // No phrase until the list is readable and has something to pick: a
      // type-to-confirm box above "there is no earlier release" invites a user to
      // type it and press a button that can only refuse.
      confirmPhrase={state.kind === 'ready' && earlier.length > 0 ? state.confirmPhrase : undefined}
      onConfirm={async (phrase) => {
        if (state.kind !== 'ready') {
          throw new Error('The release history has not loaded, so nothing can be deployed yet.');
        }
        if (!selected) throw new Error('Pick the release to go back to.');
        const payload = await fetchJson<{ message: string }>(`/api/deployments/${deployment.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rollback', targetSha: selected, confirmation: phrase }),
        });
        onDone(payload.message);
      }}
    />
  );
}
