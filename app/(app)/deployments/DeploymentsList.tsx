'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import StudioShell from '@/components/app/studio/StudioShell';
import StudioButton from '@/components/app/studio/StudioButton';
import { notify, toMessage } from '@/lib/notify';
import { cn } from '@/utils/cn';
import { formatAdminDateTime } from '../admin/format-admin-date';
import type { PublicDeployment } from '@/lib/publish/types';
import { deploymentFailure } from '@/lib/publish/failure-copy';
import RollbackDialog from './RollbackDialog';

function statusLabel(status: string) {
  if (status === 'LIVE') return 'Live';
  if (status === 'BUILDING' || status === 'QUEUED') return 'Building';
  if (status === 'FAILED') return 'Failed';
  return 'Stopped';
}

/**
 * F-260: the table used to say "Failed" beside a Redeploy button and nothing else, so the
 * user had no reason, no step and no build log — recovery was to press Redeploy and hope.
 * The reason spans the full width rather than squeezing into the Status cell, because a
 * Coolify error message is a sentence, not a word.
 */
function FailureRow({ row }: { row: PublicDeployment }) {
  const failure = deploymentFailure(row);
  if (!failure) return null;
  return (
    <tr className="border-b border-[var(--studio-line)] last:border-0">
      <td colSpan={7} className="px-16 pb-14">
        <div className="space-y-6 rounded-10 border border-[var(--studio-danger)]/30 bg-[var(--studio-danger)]/[0.04] p-12">
          <p className="text-[13px] font-medium text-[var(--studio-danger)]">{failure.headline}</p>
          <p className="break-words text-[13px] text-[var(--studio-fg)]">{failure.reason}</p>
          <div className="flex flex-wrap items-center gap-12">
            {failure.buildLogUrl && (
              <a
                href={failure.buildLogUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[13px] text-[var(--studio-accent)] hover:underline"
              >
                View build log
              </a>
            )}
            {failure.requestId && (
              <span className="text-[11px] text-[var(--studio-faint)]">
                Request {failure.requestId}
              </span>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

export default function DeploymentsList({ initial }: { initial: PublicDeployment[] }) {
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [rollbackFor, setRollbackFor] = useState<PublicDeployment | null>(null);

  const refresh = async () => {
    const list = await fetch('/api/deployments');
    const payload = await list.json().catch(() => ({}));
    if (list.ok && Array.isArray(payload.deployments)) setRows(payload.deployments);
  };

  const act = async (id: string, action: 'stop' | 'redeploy' | 'delete', confirmSlug?: string) => {
    setBusy(`${action}:${id}`);
    const pending = { stop: 'Stopping…', redeploy: 'Redeploying…', delete: 'Deleting…' }[action];
    const done = {
      stop: 'Deployment stopped.',
      redeploy: 'Redeploy started.',
      delete: 'Deployment deleted.',
    }[action];
    const toastId = notify.loading(pending);
    try {
      const response = await fetch(`/api/deployments/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, confirmSlug }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        notify.settle(toastId, 'error', data.error || `Could not ${action} this deployment`);
        return;
      }
      if (action === 'delete') {
        // A partial teardown keeps the row (it is the last thing naming the Coolify uuid
        // and DNS record id, and the orphan cron only deletes what this system recorded
        // creating). Anything other than an explicit `rowDeleted: true` therefore keeps
        // the row on screen and reads as a warning, so the list never contradicts itself
        // on the next page load.
        const removed = data.rowDeleted === true;
        notify.settle(toastId, removed ? 'success' : 'warning', data.message || done);
        if (removed) {
          setRows((current) => current.filter((row) => row.id !== id));
          return;
        }
      } else {
        notify.settle(toastId, 'success', done);
      }
      await refresh();
    } catch (cause) {
      notify.settle(toastId, 'error', toMessage(cause, `Could not ${action} this deployment`));
    } finally {
      setBusy(null);
    }
  };

  return (
    <StudioShell variant="workspace">
      <main className="mx-auto max-w-[1100px] px-20 py-40">
        <h1 className="text-[32px] font-medium tracking-[-0.03em] text-[var(--studio-fg)]">
          Deployments
        </h1>
        <p className="mt-8 text-[14px] text-[var(--studio-muted)]">
          Preview and live Coolify sites.
        </p>

        <div className="mt-24 overflow-x-auto rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)]">
          <table className="w-full text-left text-[14px]">
            <thead className="border-b border-[var(--studio-line)] text-[12px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
              <tr>
                <th className="px-16 py-12 font-medium">Project</th>
                <th className="px-16 py-12 font-medium">Kind</th>
                <th className="px-16 py-12 font-medium">Status</th>
                <th className="px-16 py-12 font-medium">URL</th>
                <th className="px-16 py-12 font-medium">By</th>
                <th className="px-16 py-12 font-medium">When</th>
                <th className="px-16 py-12 font-medium"> </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-16 py-24 text-[13px] text-[var(--studio-faint)]">
                    No deployments yet
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <Fragment key={row.id}>
                  <tr
                    className={cn(
                      'border-[var(--studio-line)] align-top',
                      deploymentFailure(row) ? '' : 'border-b last:border-0',
                    )}
                  >
                    <td className="px-16 py-14">
                      <Link
                        href={`/project/${row.projectId}`}
                        className="font-medium hover:underline"
                      >
                        {row.projectName || row.projectId}
                      </Link>
                    </td>
                    <td className="px-16 py-14">{row.kind === 'LIVE' ? 'Live' : 'Preview'}</td>
                    <td className="px-16 py-14">{statusLabel(row.status)}</td>
                    <td className="px-16 py-14">
                      {row.url ? (
                        <a
                          href={row.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[var(--studio-accent)] hover:underline"
                        >
                          {row.url.replace(/^https?:\/\//, '')}
                        </a>
                      ) : (
                        <span className="text-[var(--studio-faint)]">—</span>
                      )}
                    </td>
                    <td className="px-16 py-14 text-[var(--studio-muted)]">
                      {row.publishedBy?.name ?? '—'}
                    </td>
                    <td className="px-16 py-14 text-[var(--studio-muted)]">
                      {formatAdminDateTime(row.publishedAt)}
                    </td>
                    <td className="px-16 py-14">
                      <div className="flex flex-wrap gap-6">
                        <StudioButton
                          type="button"
                          variant="ghost"
                          disabled={busy !== null || row.status === 'STOPPED'}
                          onClick={() => void act(row.id, 'stop')}
                        >
                          Stop
                        </StudioButton>
                        <StudioButton
                          type="button"
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={() => void act(row.id, 'redeploy')}
                        >
                          Redeploy
                        </StudioButton>
                        {/* Hidden only while a build is running, because that is the one
                          case the UI can answer on its own. Whether there IS an earlier
                          release lives in the deploy repo's commit history, which this
                          table has not read — so the dialog says "only ever published
                          once", or the action refuses with which record is missing,
                          rather than this row guessing from `publishedAt`. */}
                        {row.status !== 'BUILDING' && row.status !== 'QUEUED' && (
                          <StudioButton
                            type="button"
                            variant="ghost"
                            disabled={busy !== null}
                            onClick={() => setRollbackFor(row)}
                          >
                            Roll back
                          </StudioButton>
                        )}
                        <StudioButton
                          type="button"
                          variant="danger"
                          disabled={busy !== null}
                          onClick={() => {
                            const typed = window.prompt(
                              `Delete + DNS cleanup. Type the slug: ${row.slug}`,
                            );
                            if (typed) void act(row.id, 'delete', typed);
                          }}
                        >
                          Delete
                        </StudioButton>
                      </div>
                    </td>
                  </tr>
                  <FailureRow row={row} />
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        <RollbackDialog
          deployment={rollbackFor}
          onClose={() => setRollbackFor(null)}
          onDone={(message) => {
            setRollbackFor(null);
            notify.success(message);
            void refresh();
          }}
        />
      </main>
    </StudioShell>
  );
}
