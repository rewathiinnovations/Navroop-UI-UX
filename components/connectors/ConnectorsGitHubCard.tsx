'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Github, X } from 'lucide-react';
import StudioButton from '@/components/app/studio/StudioButton';
import ConfirmAction from '@/components/admin/ConfirmAction';
import { disconnectGitHub } from '@/lib/github/actions';

const DISCONNECT_COPY =
  "Projects you've already pushed will keep their repo link, but you won't be able to push further updates until you reconnect.";

export default function ConnectorsGitHubCard({
  connected,
  githubUsername,
  banner,
  isAdmin = false,
}: {
  connected: boolean;
  githubUsername?: string;
  banner: 'connected' | 'error' | 'unconfigured' | null;
  isAdmin?: boolean;
}) {
  const router = useRouter();
  const [visibleBanner, setVisibleBanner] = useState(banner);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!banner) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('github');
    const query = url.searchParams.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${query ? `?${query}` : ''}${url.hash}`,
    );
  }, [banner]);

  const onConfirmDisconnect = async () => {
    const result = await disconnectGitHub();
    if (!result.ok) {
      throw new Error(result.error || 'Could not disconnect GitHub');
    }
    router.refresh();
  };

  return (
    <div className="mt-24 space-y-16">
      {visibleBanner === 'connected' && (
        <div
          className="flex items-start justify-between gap-12 rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-16 py-12 text-[14px] text-[var(--studio-fg)]"
          role="status"
        >
          <p>GitHub connected</p>
          <button
            type="button"
            onClick={() => setVisibleBanner(null)}
            aria-label="Dismiss"
            className="inline-flex size-28 items-center justify-center rounded-8 text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]"
          >
            <X className="size-14" />
          </button>
        </div>
      )}
      {visibleBanner === 'unconfigured' && (
        <div
          className="flex items-start justify-between gap-12 rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-16 py-12 text-[14px] text-[var(--studio-fg)]"
          role="alert"
        >
          <p>
            GitHub isn&apos;t set up on this server yet, so connecting can&apos;t start.{' '}
            {isAdmin ? (
              <>
                Add a GitHub OAuth client ID and secret in{' '}
                <Link href="/admin/config#connectors" className="underline underline-offset-2">
                  Admin &rarr; Configuration
                </Link>
                .
              </>
            ) : (
              'Ask an administrator to configure it.'
            )}
          </p>
          <button
            type="button"
            onClick={() => setVisibleBanner(null)}
            aria-label="Dismiss"
            className="inline-flex size-28 shrink-0 items-center justify-center rounded-8 text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]"
          >
            <X className="size-14" />
          </button>
        </div>
      )}
      {visibleBanner === 'error' && (
        <div
          className="flex items-start justify-between gap-12 rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-16 py-12 text-[14px] text-[var(--studio-danger)]"
          role="alert"
        >
          <p>Connection failed, please try again</p>
          <button
            type="button"
            onClick={() => setVisibleBanner(null)}
            aria-label="Dismiss"
            className="inline-flex size-28 items-center justify-center rounded-8 text-[var(--studio-muted)] hover:bg-[var(--studio-surface-hover)] hover:text-[var(--studio-fg)]"
          >
            <X className="size-14" />
          </button>
        </div>
      )}

      <section className="flex items-start justify-between gap-16 rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-20">
        <div className="flex min-w-0 items-start gap-12">
          <span className="mt-2 inline-flex size-36 shrink-0 items-center justify-center rounded-10 bg-[var(--studio-bg)] text-[var(--studio-fg)]">
            <Github className="size-18" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-[16px] font-medium text-[var(--studio-fg)]">GitHub</h2>
            <p className="mt-4 text-[13px] leading-5 text-[var(--studio-muted)]">
              {connected
                ? `Connected as ${githubUsername}`
                : 'Push generated projects to a repo in your GitHub account'}
            </p>
          </div>
        </div>

        {connected ? (
          <StudioButton type="button" variant="danger" onClick={() => setConfirmOpen(true)}>
            Disconnect
          </StudioButton>
        ) : (
          <a
            href="/api/github/connect"
            className="inline-flex min-h-[44px] items-center justify-center rounded-full [background-image:var(--studio-cta-gradient)] px-18 text-[14px] font-medium tracking-[-0.01em] text-[var(--studio-cta-fg)] no-underline transition-[filter] duration-200 hover:brightness-[1.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--studio-bg)]"
          >
            Connect
          </a>
        )}
      </section>

      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Disconnect GitHub?"
        body={DISCONNECT_COPY}
        confirmLabel="Disconnect"
        busyLabel="Disconnecting…"
        onConfirm={onConfirmDisconnect}
      />
    </div>
  );
}
