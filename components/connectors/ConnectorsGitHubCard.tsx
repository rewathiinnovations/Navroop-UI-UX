'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Github, X } from 'lucide-react';
import StudioButton from '@/components/app/studio/StudioButton';
import { disconnectGitHub } from '@/lib/github/actions';

const DISCONNECT_COPY =
  "Disconnect GitHub? Projects you've already pushed will keep their repo link, but you won't be able to push further updates until you reconnect.";

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
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirmOpen]);

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
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      const result = await disconnectGitHub();
      if (result.ok) {
        setConfirmOpen(false);
        router.refresh();
        return;
      }
      setDisconnectError(result.error || 'Could not disconnect GitHub');
    } finally {
      setDisconnecting(false);
    }
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
            className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-[var(--studio-accent)] px-18 text-[14px] font-medium tracking-[-0.01em] text-[var(--studio-cta-fg)] no-underline transition-colors duration-200 hover:bg-[var(--studio-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--studio-bg)]"
          >
            Connect
          </a>
        )}
      </section>

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-20">
          <button
            type="button"
            aria-label="Cancel disconnect"
            className="absolute inset-0 bg-[var(--studio-fg)]/20"
            onClick={() => setConfirmOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="disconnect-github-title"
            className="relative z-10 w-full max-w-[420px] rounded-16 border border-[var(--studio-line)] bg-[var(--studio-surface)] p-24 shadow-lg"
          >
            <p
              id="disconnect-github-title"
              className="text-[15px] leading-6 text-[var(--studio-fg)]"
            >
              {DISCONNECT_COPY}
            </p>
            {disconnectError && (
              <p className="mt-12 text-[13px] text-[var(--studio-danger)]" role="alert">
                {disconnectError}
              </p>
            )}
            <div className="mt-20 flex justify-end gap-8">
              <StudioButton type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>
                Cancel
              </StudioButton>
              <StudioButton
                type="button"
                variant="danger"
                disabled={disconnecting}
                onClick={() => {
                  void onConfirmDisconnect();
                }}
              >
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </StudioButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
