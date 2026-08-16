'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { cn } from '@/utils/cn';

type PaletteProject = { id: string; name: string };

type CommandPaletteContextValue = {
  openPalette: () => void;
};

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

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
    const onKey = (event: KeyboardEvent) => {
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
        const response = await fetch(
          `/api/projects?search=${encodeURIComponent(needle)}`,
          { signal: controller.signal },
        );
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
    }, 280);

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
    const onKey = (event: KeyboardEvent) => {
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

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
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
                <p className="px-10 py-12 text-[13px] text-[var(--studio-muted)]">No matching projects</p>
              )}
              {!loading && results.map((project, index) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => goTo(project)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={cn(
                    'flex w-full min-h-[44px] items-center rounded-10 px-10 text-left text-[14px] text-[var(--studio-fg)] transition-colors duration-200',
                    index === activeIndex
                      ? 'bg-[var(--studio-surface-hover)]'
                      : 'hover:bg-[var(--studio-surface-hover)]',
                  )}
                >
                  {project.name}
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
