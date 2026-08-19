'use client';

import { useEffect, useMemo, useState } from 'react';
import { Brain } from 'lucide-react';
import { useAuth } from '@/components/app/auth/AuthProvider';
import SkillsPanel from '@/components/settings/SkillsPanel';
import {
  archiveMemory,
  createMemory,
  getMemoryBudget,
  listBrainMemories,
  reactivateMemory,
  updateMemory,
} from '@/lib/memory/actions';
import {
  MEMORY_CATEGORIES,
  MEMORY_TOKEN_BUDGET,
  type MemoryCategory,
  type PublicMemory,
} from '@/lib/memory/types';
import { notify } from '@/lib/notify';

const CATEGORY_LABEL: Record<MemoryCategory, string> = {
  design: 'Design',
  tech: 'Tech',
  content: 'Content',
  context: 'Context',
};

function groupByCategory(entries: PublicMemory[]) {
  const groups = MEMORY_CATEGORIES.map((category) => ({
    category,
    items: entries.filter((row) => row.category === category && row.status === 'ACTIVE'),
  }));
  return groups.filter((group) => group.items.length > 0);
}

function MemoryRow({
  entry,
  canEdit,
  onChanged,
}: {
  entry: PublicMemory;
  canEdit: boolean;
  onChanged: (row: PublicMemory, removed?: boolean) => void;
}) {
  const [draft, setDraft] = useState(entry.content);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(entry.content);
  }, [entry.content]);

  const save = async () => {
    if (!canEdit || draft.trim() === entry.content) {
      setEditing(false);
      return;
    }
    setBusy(true);
    const result = await updateMemory(entry.id, draft);
    setBusy(false);
    if (!result.ok) {
      notify.error(result.error, { key: `memory-${entry.id}` });
      return;
    }
    onChanged(result.data);
    setEditing(false);
    notify.success('Memory updated.', { key: `memory-${entry.id}` });
  };

  return (
    <li className="rounded-10 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-12 py-10">
      {editing && canEdit ? (
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void save()}
          maxLength={500}
          rows={2}
          disabled={busy}
          className="w-full rounded-8 border border-[var(--studio-line)] bg-[var(--studio-bg)] px-8 py-6 text-[13px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
        />
      ) : (
        <p className="text-[13px] leading-5 text-[var(--studio-fg)]">{entry.content}</p>
      )}
      {canEdit && (
        <div className="mt-8 flex gap-8">
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing((value) => !value)}
            className="text-[12px] font-medium text-[var(--studio-muted)] hover:text-[var(--studio-fg)]"
          >
            {editing ? 'Done' : 'Edit'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const result = await archiveMemory(entry.id);
              setBusy(false);
              if (!result.ok) {
                notify.error(result.error, { key: `memory-${entry.id}` });
                return;
              }
              onChanged(result.data, true);
              notify.success('Memory archived.', { key: `memory-${entry.id}` });
            }}
            className="text-[12px] font-medium text-[var(--studio-muted)] hover:text-[var(--studio-fg)]"
          >
            Archive
          </button>
        </div>
      )}
    </li>
  );
}

function AddEntry({
  scope,
  projectId,
  disabled,
  onCreated,
}: {
  scope: 'WORKSPACE' | 'PROJECT';
  projectId?: string;
  disabled: boolean;
  onCreated: (row: PublicMemory) => void;
}) {
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<MemoryCategory>('design');
  const [busy, setBusy] = useState(false);

  if (disabled) return null;

  return (
    <form
      className="mt-10 space-y-8"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const result = await createMemory({
          scope,
          projectId: scope === 'PROJECT' ? projectId : null,
          category,
          content,
        });
        setBusy(false);
        if (!result.ok) {
          notify.error(result.error, { key: `memory-add-${scope}` });
          return;
        }
        setContent('');
        onCreated(result.data);
        notify.success('Entry added to the brain.', { key: `memory-add-${scope}` });
      }}
    >
      <div className="flex flex-wrap gap-8">
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value as MemoryCategory)}
          className="h-32 rounded-8 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-8 text-[12px] text-[var(--studio-fg)]"
        >
          {MEMORY_CATEGORIES.map((item) => (
            <option key={item} value={item}>
              {CATEGORY_LABEL[item]}
            </option>
          ))}
        </select>
        <input
          value={content}
          onChange={(event) => setContent(event.target.value)}
          maxLength={500}
          required
          placeholder="Add a durable preference"
          className="min-w-0 flex-1 rounded-8 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-10 py-6 text-[13px] text-[var(--studio-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
        />
        <button
          type="submit"
          disabled={busy || !content.trim()}
          className="inline-flex h-32 items-center rounded-full border border-[var(--studio-line-strong)] px-12 text-[12px] font-medium text-[var(--studio-fg)] hover:bg-[var(--studio-surface-hover)] disabled:opacity-50"
        >
          Add entry
        </button>
      </div>
    </form>
  );
}

function PendingStrip({
  entries,
  canEdit,
  onChanged,
}: {
  entries: PublicMemory[];
  canEdit: boolean;
  onChanged: (row: PublicMemory, removed?: boolean) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  if (entries.length === 0) return null;

  return (
    <section className="border-b border-[var(--studio-line)] bg-amber-500/8 px-16 py-12">
      <h3 className="text-[13px] font-semibold text-[var(--studio-fg)]">Review extracted memory</h3>
      <p className="mt-4 text-[12px] text-[var(--studio-muted)]">
        These are not injected until you approve them.
      </p>
      <ul className="mt-10 space-y-8">
        {entries.map((entry) => {
          const draft = drafts[entry.id] ?? entry.content;
          const editing = editingId === entry.id;
          return (
            <li
              key={entry.id}
              className="rounded-10 border border-amber-500/20 bg-[var(--studio-surface)] px-12 py-10"
            >
              <p className="text-[11px] uppercase tracking-[0.06em] text-[var(--studio-faint)]">
                {CATEGORY_LABEL[entry.category]} ·{' '}
                {entry.scope === 'WORKSPACE' ? 'Workspace' : 'This project'}
              </p>
              {editing ? (
                <textarea
                  value={draft}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [entry.id]: event.target.value }))
                  }
                  maxLength={500}
                  rows={2}
                  className="mt-6 w-full rounded-8 border border-[var(--studio-line)] px-8 py-6 text-[13px]"
                />
              ) : (
                <p className="mt-6 text-[13px] leading-5 text-[var(--studio-fg)]">
                  {entry.content}
                </p>
              )}
              {canEdit && (
                <div className="mt-8 flex flex-wrap gap-8">
                  <button
                    type="button"
                    onClick={async () => {
                      const result = await reactivateMemory(entry.id);
                      if (!result.ok) {
                        notify.error(result.error, { key: `memory-${entry.id}` });
                        return;
                      }
                      onChanged(result.data);
                      notify.success('Memory approved — it will be injected from now on.', {
                        key: `memory-${entry.id}`,
                      });
                    }}
                    className="text-[12px] font-medium text-[var(--studio-fg)] hover:underline"
                  >
                    Approve
                  </button>
                  {editing ? (
                    <button
                      type="button"
                      onClick={async () => {
                        const updated = await updateMemory(entry.id, draft);
                        if (!updated.ok) {
                          notify.error(updated.error, { key: `memory-${entry.id}` });
                          return;
                        }
                        const approved = await reactivateMemory(entry.id);
                        if (!approved.ok) {
                          notify.error(approved.error, { key: `memory-${entry.id}` });
                          return;
                        }
                        setEditingId(null);
                        onChanged(approved.data);
                        notify.success('Memory saved and approved.', {
                          key: `memory-${entry.id}`,
                        });
                      }}
                      className="text-[12px] font-medium text-[var(--studio-fg)] hover:underline"
                    >
                      Save & approve
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditingId(entry.id)}
                      className="text-[12px] font-medium text-[var(--studio-muted)] hover:text-[var(--studio-fg)]"
                    >
                      Edit & approve
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={async () => {
                      const result = await archiveMemory(entry.id);
                      if (!result.ok) {
                        notify.error(result.error, { key: `memory-${entry.id}` });
                        return;
                      }
                      onChanged(result.data, true);
                      notify.success('Suggestion dismissed.', { key: `memory-${entry.id}` });
                    }}
                    className="text-[12px] font-medium text-[var(--studio-muted)] hover:text-[var(--studio-fg)]"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function BrainPanel({ projectId }: { projectId: string }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [workspace, setWorkspace] = useState<PublicMemory[]>([]);
  const [project, setProject] = useState<PublicMemory[]>([]);
  const [budget, setBudget] = useState<{ tokenEstimate: number; truncated: boolean } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [canEditProject, setCanEditProject] = useState(isAdmin);

  const pending = useMemo(
    () => [...workspace, ...project].filter((row) => row.status === 'PENDING'),
    [workspace, project],
  );

  const refreshBudget = async () => {
    const result = await getMemoryBudget(projectId);
    if (result.ok)
      setBudget({ tokenEstimate: result.data.tokenEstimate, truncated: result.data.truncated });
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([listBrainMemories(projectId), getMemoryBudget(projectId)]).then(
      ([list, usage]) => {
        if (cancelled) return;
        setLoading(false);
        if (!list.ok) {
          setError(list.error);
          return;
        }
        setWorkspace(list.data.workspace);
        setProject(list.data.project);
        setCanEditProject(isAdmin || Boolean(user?.id));
        if (usage.ok)
          setBudget({ tokenEstimate: usage.data.tokenEstimate, truncated: usage.data.truncated });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, isAdmin, user?.id]);

  useEffect(() => {
    if (!user?.id || isAdmin) {
      setCanEditProject(isAdmin);
      return;
    }
    // Owner check is enforced server-side; members can still attempt add and get 403.
    setCanEditProject(true);
  }, [isAdmin, user?.id]);

  const replaceIn = (setter: typeof setWorkspace, row: PublicMemory, removed?: boolean) => {
    setter((current) => {
      const next = current.filter((item) => item.id !== row.id);
      if (removed || row.status === 'ARCHIVED') return next;
      return [row, ...next];
    });
    void refreshBudget();
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--studio-bg)]">
      <div className="border-b border-[var(--studio-line)] px-16 py-12">
        <div className="flex items-center gap-8">
          <Brain className="size-16 text-[var(--studio-muted)]" />
          <h2 className="text-[14px] font-semibold text-[var(--studio-fg)]">Brain</h2>
        </div>
        <p className="mt-4 text-[12px] text-[var(--studio-faint)]">
          Durable context injected into every generation. Skills stay conditional and live below.
        </p>
      </div>

      {error && (
        <p className="px-16 py-8 text-[12px] text-[var(--studio-danger)]" role="alert">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <PendingStrip
          entries={pending}
          canEdit={isAdmin || canEditProject}
          onChanged={(row, removed) => {
            if (row.scope === 'WORKSPACE') replaceIn(setWorkspace, row, removed);
            else replaceIn(setProject, row, removed);
          }}
        />

        <section className="border-b border-[var(--studio-line)] px-16 py-14">
          <h3 className="text-[13px] font-semibold text-[var(--studio-fg)]">Workspace memory</h3>
          <p className="mt-4 text-[12px] text-[var(--studio-muted)]">
            Applies to every project. {isAdmin ? 'Admins can edit.' : 'Members can read only.'}
          </p>
          {loading ? (
            <p className="mt-10 text-[13px] text-[var(--studio-muted)]">Loading…</p>
          ) : (
            <div className="mt-10 space-y-12">
              {groupByCategory(workspace).map((group) => (
                <div key={group.category}>
                  <p className="mb-6 text-[11px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
                    {CATEGORY_LABEL[group.category]}
                  </p>
                  <ul className="space-y-8">
                    {group.items.map((entry) => (
                      <MemoryRow
                        key={entry.id}
                        entry={entry}
                        canEdit={isAdmin}
                        onChanged={(row, removed) => replaceIn(setWorkspace, row, removed)}
                      />
                    ))}
                  </ul>
                </div>
              ))}
              {workspace.filter((row) => row.status === 'ACTIVE').length === 0 && (
                <p className="text-[13px] text-[var(--studio-muted)]">No workspace memory yet.</p>
              )}
            </div>
          )}
          <AddEntry
            scope="WORKSPACE"
            disabled={!isAdmin}
            onCreated={(row) => replaceIn(setWorkspace, row)}
          />
        </section>

        <section className="border-b border-[var(--studio-line)] px-16 py-14">
          <h3 className="text-[13px] font-semibold text-[var(--studio-fg)]">This project</h3>
          <p className="mt-4 text-[12px] text-[var(--studio-muted)]">
            Only affects this project. Owner or admin can edit.
          </p>
          {loading ? (
            <p className="mt-10 text-[13px] text-[var(--studio-muted)]">Loading…</p>
          ) : (
            <div className="mt-10 space-y-12">
              {groupByCategory(project).map((group) => (
                <div key={group.category}>
                  <p className="mb-6 text-[11px] uppercase tracking-[0.08em] text-[var(--studio-faint)]">
                    {CATEGORY_LABEL[group.category]}
                  </p>
                  <ul className="space-y-8">
                    {group.items.map((entry) => (
                      <MemoryRow
                        key={entry.id}
                        entry={entry}
                        canEdit={canEditProject}
                        onChanged={(row, removed) => replaceIn(setProject, row, removed)}
                      />
                    ))}
                  </ul>
                </div>
              ))}
              {project.filter((row) => row.status === 'ACTIVE').length === 0 && (
                <p className="text-[13px] text-[var(--studio-muted)]">No project memory yet.</p>
              )}
            </div>
          )}
          <AddEntry
            scope="PROJECT"
            projectId={projectId}
            disabled={!canEditProject}
            onCreated={(row) => replaceIn(setProject, row)}
          />
        </section>

        <div className="px-16 py-14">
          <SkillsPanel />
        </div>
      </div>

      <footer className="border-t border-[var(--studio-line)] px-16 py-10">
        <p className="text-[12px] text-[var(--studio-muted)]">
          Active memory: {budget ? `${budget.tokenEstimate} / ${MEMORY_TOKEN_BUDGET} tokens` : '—'}
        </p>
        {budget?.truncated && (
          <p className="mt-4 text-[12px] text-amber-700 dark:text-amber-400" role="status">
            Some rules are not injected — the block is truncated at the 1500-token budget. Archive
            unused entries so later rules can take effect.
          </p>
        )}
      </footer>
    </div>
  );
}
