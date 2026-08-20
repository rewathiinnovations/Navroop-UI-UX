'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import StudioModal from '@/components/ui/StudioModal';
import { cn } from '@/utils/cn';

type PaletteProject = { id: string; name: string; snippet?: string; status?: string };

type CommandPaletteContextValue = {
  openPalette: () => void;
};

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

// Postgres `ts_headline` wraps matched lexemes in <mark>…</mark> and passes the rest of
// the document through verbatim, so a search snippet is a project name/prompt — member
// input, validated only for length — carrying two known delimiters. It used to be handed
// to dangerouslySetInnerHTML, which meant a project named `<img src=x onerror=…>` ran
// script in every other member's palette, admins included, with no CSP to stop it.
// Splitting on the delimiters and returning React nodes keeps the highlight and removes
// the raw-HTML sink: everything outside a <mark> is a text node React escapes for us.
const HIGHLIGHT = /<mark>([\s\S]*?)<\/mark>/g;

export function renderSnippet(snippet: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of snippet.matchAll(HIGHLIGHT)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(snippet.slice(cursor, start));
    nodes.push(<mark key={start}>{match[1]}</mark>);
    cursor = start + match[0].length;
  }
  if (cursor < snippet.length) nodes.push(snippet.slice(cursor));
  return nodes;
}

/**
 * F-425: `/api/search` failing was indistinguishable from a search that matched
 * nothing — both rendered "Nothing found". A user whose project exists
 * concluded it was gone. The panel body is one of six mutually exclusive
 * states, decided here so a failure can never read as an empty result.
 *
 * The palette is mounted in `app/providers.tsx`, so Cmd+K works on the
 * signed-out landing page too, where the API answers 401. That is not an
 * outage: "reload and try again" would never fix it, and "your projects are
 * still there" is not a claim we can make to a visitor. It gets its own state.
 */
export type PaletteView = 'hint' | 'loading' | 'signedOut' | 'failed' | 'empty' | 'results';

/** `none` also covers a search that has not been attempted yet. */
export type PaletteFailure = 'none' | 'signedOut' | 'unavailable';

export const SEARCH_UNAVAILABLE = 'Search is unavailable right now.';

export const SEARCH_SIGN_IN = 'Sign in to search your projects.';

export function paletteView(input: {
  query: string;
  loading: boolean;
  failure: PaletteFailure;
  resultCount: number;
}): PaletteView {
  if (!input.query.trim()) return 'hint';
  if (input.loading) return 'loading';
  if (input.failure === 'signedOut') return 'signedOut';
  if (input.failure === 'unavailable') return 'failed';
  return input.resultCount > 0 ? 'results' : 'empty';
}

export function useCommandPalette() {
  const context = useContext(CommandPaletteContext);
  if (!context) {
    throw new Error('useCommandPalette must be used within CommandPaletteProvider');
  }
  return context;
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PaletteProject[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<PaletteFailure>('none');

  const openPalette = useCallback(() => {
    setOpen(true);
    setQuery('');
    setResults([]);
    setFailure('none');
    setActiveIndex(0);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    setQuery('');
    setResults([]);
    setFailure('none');
    setActiveIndex(0);
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => {
          if (current) return false;
          setQuery('');
          setResults([]);
          setFailure('none');
          setActiveIndex(0);
          return true;
        });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // No focus timer and no outside-click listener: Radix's FocusScope moves focus
  // into the panel on open, traps Tab there, `hideOthers()` marks the page behind
  // it `aria-hidden`, and DismissableLayer owns Escape and outside pointer-downs
  // (N-019). The hand-rolled version had none of that — Tab walked straight into
  // the sidebar behind the overlay.

  useEffect(() => {
    if (!open) return;
    const needle = query.trim();
    if (!needle) {
      setResults([]);
      setFailure('none');
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(needle)}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          setResults([]);
          // 401/403 is the signed-out landing page, not an outage.
          setFailure(
            response.status === 401 || response.status === 403 ? 'signedOut' : 'unavailable',
          );
          return;
        }
        const data = (await response.json()) as { projects?: PaletteProject[] };
        setResults(data.projects ?? []);
        setFailure('none');
        setActiveIndex(0);
      } catch (error) {
        // `fetch` rejects with a DOMException named AbortError when the controller
        // fires; that is this effect cleaning up after itself, not a failure.
        const aborted = error instanceof Error && error.name === 'AbortError';
        if (!aborted) {
          setResults([]);
          setFailure('unavailable');
        }
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const goTo = useCallback(
    (project: PaletteProject) => {
      closePalette();
      router.push(`/project/${project.id}`);
    },
    [closePalette, router],
  );

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const top = results[activeIndex] ?? results[0];
      if (top) goTo(top);
    }
  };

  const view = paletteView({ query, loading, failure, resultCount: results.length });

  return (
    <CommandPaletteContext.Provider value={{ openPalette }}>
      {children}
      <StudioModal
        open={open}
        onOpenChange={(next) => {
          if (!next) closePalette();
        }}
        title="Search projects"
        hideTitle
        placement="top"
        // `studio-portal` carries the studio palette. This provider is mounted in
        // app/providers.tsx, outside `.studio-shell`, so every `var(--studio-*)`
        // here resolved to nothing and the panel shipped with no background at
        // all — the same scoping the class exists for (components/app/studio/studio.css).
        className={cn(
          'studio-portal w-full max-w-[560px] overflow-hidden rounded-12',
          'border border-[var(--studio-line)] bg-[var(--studio-surface)]',
          'shadow-[0_16px_48px_rgba(24,24,27,0.18)]',
          'focus-visible:outline-none',
        )}
      >
        <div className="flex items-center gap-10 border-b border-[var(--studio-line)] px-16">
          <Search className="size-16 shrink-0 text-[var(--studio-faint)]" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search projects"
            aria-label="Search projects"
            className="h-48 w-full bg-transparent text-[15px] text-[var(--studio-fg)] placeholder:text-[var(--studio-faint)] focus-visible:outline-none"
          />
        </div>
        <div className="max-h-[320px] overflow-y-auto p-6">
          {view === 'loading' && (
            <p className="px-10 py-12 text-[13px] text-[var(--studio-muted)]">Searching…</p>
          )}
          {view === 'failed' && (
            <p role="alert" className="px-10 py-12 text-[13px] text-[var(--studio-danger)]">
              {SEARCH_UNAVAILABLE} Your projects are still there — reload the page and try again.
            </p>
          )}
          {view === 'signedOut' && (
            <p role="status" className="px-10 py-12 text-[13px] text-[var(--studio-muted)]">
              {SEARCH_SIGN_IN}
            </p>
          )}
          {view === 'empty' && (
            <p className="px-10 py-12 text-[13px] text-[var(--studio-muted)]">Nothing found</p>
          )}
          {view === 'results' &&
            results.map((project, index) => (
              <button
                key={project.id}
                type="button"
                onClick={() => goTo(project)}
                onMouseEnter={() => setActiveIndex(index)}
                className={cn(
                  'flex w-full min-h-[44px] flex-col items-start justify-center rounded-10 px-10 py-8 text-left transition-colors duration-200',
                  index === activeIndex
                    ? 'bg-[var(--studio-surface-hover)]'
                    : 'hover:bg-[var(--studio-surface-hover)]',
                )}
              >
                <span className="flex w-full items-center justify-between gap-8">
                  <span className="truncate text-[14px] text-[var(--studio-fg)]">
                    {project.name}
                  </span>
                  {project.status ? (
                    <span className="shrink-0 rounded-full border border-[var(--studio-line)] px-6 py-1 text-[11px] capitalize text-[var(--studio-muted)]">
                      {project.status}
                    </span>
                  ) : null}
                </span>
                {project.snippet ? (
                  <span className="mt-2 line-clamp-2 text-[12px] text-[var(--studio-faint)] [&_mark]:bg-transparent [&_mark]:font-medium [&_mark]:text-[var(--studio-fg)]">
                    {renderSnippet(project.snippet)}
                  </span>
                ) : null}
              </button>
            ))}
          {view === 'hint' && (
            <p className="px-10 py-12 text-[13px] text-[var(--studio-muted)]">
              Type to search, then press Enter to open.
            </p>
          )}
        </div>
      </StudioModal>
    </CommandPaletteContext.Provider>
  );
}
