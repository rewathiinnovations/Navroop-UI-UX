'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
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
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const openPalette = useCallback(() => {
    setOpen(true);
    setQuery('');
    setResults([]);
    setActiveIndex(0);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    setQuery('');
    setResults([]);
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
          setActiveIndex(0);
          return true;
        });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const needle = query.trim();
    if (!needle) {
      setResults([]);
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
        if (!response.ok) return;
        const data = (await response.json()) as { projects?: PaletteProject[] };
        setResults(data.projects ?? []);
        setActiveIndex(0);
      } catch (error) {
        if ((error as { name?: string }).name !== 'AbortError') {
          setResults([]);
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

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) {
        closePalette();
      }
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePalette();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, closePalette]);

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

  return (
    <CommandPaletteContext.Provider value={{ openPalette }}>
      {children}
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-16 pt-[12vh]">
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Search projects"
            className={cn(
              'w-full max-w-[560px] overflow-hidden rounded-12',
              'border border-[var(--studio-line)] bg-[var(--studio-surface)]',
              'shadow-[0_16px_48px_rgba(24,24,27,0.18)]',
            )}
          >
            <div className="flex items-center gap-10 border-b border-[var(--studio-line)] px-16">
              <Search className="size-16 shrink-0 text-[var(--studio-faint)]" aria-hidden />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder="Search projects"
                aria-label="Search projects"
                className="h-48 w-full bg-transparent text-[15px] text-[var(--studio-fg)] placeholder:text-[var(--studio-faint)] focus-visible:outline-none"
              />
            </div>
            <div className="max-h-[320px] overflow-y-auto p-6">
              {loading && (
                <p className="px-10 py-12 text-[13px] text-[var(--studio-muted)]">Searching…</p>
              )}
              {!loading && query.trim() && results.length === 0 && (
                <p className="px-10 py-12 text-[13px] text-[var(--studio-muted)]">Nothing found</p>
              )}
              {!loading &&
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
              {!query.trim() && (
                <p className="px-10 py-12 text-[13px] text-[var(--studio-muted)]">
                  Type to search, then press Enter to open.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </CommandPaletteContext.Provider>
  );
}
