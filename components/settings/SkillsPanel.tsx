'use client';

import { FormEvent, useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import StudioButton from '@/components/app/studio/StudioButton';
import StudioField from '@/components/app/studio/StudioField';
import ConfirmAction from '@/components/admin/ConfirmAction';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { useAuth } from '@/components/app/auth/AuthProvider';
import {
  createSkill,
  deleteSkill,
  listSkills,
  toggleSkillEnabled,
  updateSkill,
  type PublicSkill,
} from '@/lib/skills/actions';
import { notify } from '@/lib/notify';

type Draft = {
  id?: string;
  name: string;
  description: string;
  content: string;
};

const EMPTY_DRAFT: Draft = { name: '', description: '', content: '' };

export default function SkillsPanel() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [skills, setSkills] = useState<PublicSkill[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await listSkills();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSkills(result.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const saveDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !isAdmin) return;
    const isNew = !draft.id;
    setSaving(true);
    try {
      const result = draft.id
        ? await updateSkill({
            id: draft.id,
            name: draft.name,
            description: draft.description,
            content: draft.content,
          })
        : await createSkill({
            name: draft.name,
            description: draft.description,
            content: draft.content,
          });
      if (!result.ok) {
        notify.error(result.error, { key: 'skill-save' });
        return;
      }
      setDraft(null);
      await load();
      notify.success(isNew ? 'Skill created.' : 'Skill saved.', { key: 'skill-save' });
    } catch (cause) {
      notify.error(cause, { fallback: 'Could not save the skill', key: 'skill-save' });
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (skill: PublicSkill) => {
    if (!isAdmin) return;
    const result = await toggleSkillEnabled(skill.id);
    if (!result.ok) {
      notify.error(result.error, { key: `skill-${skill.id}` });
      return;
    }
    setSkills((current) => current.map((row) => (row.id === result.data.id ? result.data : row)));
    notify.success(`“${result.data.name}” ${result.data.enabled ? 'enabled' : 'disabled'}.`, {
      key: `skill-${skill.id}`,
    });
  };

  const remove = async (skill: PublicSkill) => {
    if (!isAdmin) return;
    const result = await deleteSkill(skill.id);
    if (!result.ok) {
      notify.error(result.error, { key: `skill-${skill.id}` });
      return;
    }
    setSkills((current) => current.filter((row) => row.id !== skill.id));
    if (draft?.id === skill.id) setDraft(null);
    notify.success(`“${skill.name}” deleted.`, { key: `skill-${skill.id}` });
  };

  return (
    <section className="space-y-16">
      <div>
        <h2 className="text-[18px] font-medium text-[var(--studio-fg)]">Skills</h2>
        <p className="mt-6 text-[13px] leading-5 text-[var(--studio-muted)]">
          Conditional instruction sets that load into a generation only when the task matches.
          Project Brain memory is a separate always-on concern.
        </p>
        {!isAdmin && (
          <p className="mt-8 text-[12px] text-[var(--studio-faint)]">
            Only admins can create, edit, or disable workspace skills.
          </p>
        )}
      </div>

      {error && (
        <p className="flex items-start gap-8 text-[13px] text-[var(--studio-danger)]" role="alert">
          <CircleAlert className="mt-2 size-16" aria-hidden />
          {error}
        </p>
      )}

      {loading ? (
        <div role="status" aria-label="Loading skills" className="space-y-10">
          {[0, 1].map((key) => (
            <div
              key={key}
              aria-hidden
              className="h-88 animate-pulse rounded-12 bg-[var(--studio-skeleton)]"
            />
          ))}
        </div>
      ) : (
        <ul className="space-y-10">
          {skills.map((skill) => (
            <li
              key={skill.id}
              className="rounded-12 border border-[var(--studio-line)] bg-[var(--studio-surface)] px-16 py-14"
            >
              <div className="flex items-start justify-between gap-12">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-medium text-[var(--studio-fg)]">
                    {skill.name}
                  </p>
                  <p className="mt-4 text-[13px] leading-5 text-[var(--studio-muted)]">
                    {skill.description}
                  </p>
                  <p className="mt-6 text-[12px] text-[var(--studio-faint)]">
                    Used {skill.usageCount} time{skill.usageCount === 1 ? '' : 's'}
                  </p>
                </div>
                {isAdmin && (
                  <div className="flex shrink-0 items-center gap-8">
                    <label className="inline-flex items-center gap-6 text-[12px] text-[var(--studio-muted)]">
                      <input
                        type="checkbox"
                        className="size-16 rounded-4 accent-[var(--studio-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
                        checked={skill.enabled}
                        onChange={() => void toggle(skill)}
                        aria-label={`Enable ${skill.name}`}
                      />
                      {skill.enabled ? 'On' : 'Off'}
                    </label>
                    <StudioButton
                      type="button"
                      variant="ghost"
                      className="min-h-[36px] px-12 text-[12px]"
                      onClick={() =>
                        setDraft({
                          id: skill.id,
                          name: skill.name,
                          description: skill.description,
                          content: skill.content,
                        })
                      }
                    >
                      Edit
                    </StudioButton>
                    <ConfirmAction
                      label="Delete"
                      title={`Delete “${skill.name}”?`}
                      body="This skill will stop matching on new generations. This cannot be undone."
                      confirmLabel="Delete"
                      variant="danger"
                      triggerClassName="min-h-[36px] px-12 text-[12px]"
                      onConfirm={() => remove(skill)}
                    />
                  </div>
                )}
              </div>
            </li>
          ))}
          {skills.length === 0 && (
            <li>
              <EmptyState
                title="No workspace skills yet"
                description="Admins can add conditional instruction sets that load into a generation when the task matches."
              />
            </li>
          )}
        </ul>
      )}

      {isAdmin && !draft && (
        <StudioButton type="button" variant="ghost" onClick={() => setDraft(EMPTY_DRAFT)}>
          New skill
        </StudioButton>
      )}

      {isAdmin && draft && (
        <form
          onSubmit={saveDraft}
          className="space-y-16 rounded-12 border border-[var(--studio-line)] p-16"
        >
          <h3 className="text-[15px] font-medium text-[var(--studio-fg)]">
            {draft.id ? 'Edit skill' : 'New skill'}
          </h3>
          <StudioField
            id="skill-name"
            label="Name"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            required
            maxLength={60}
          />
          <div className="space-y-8">
            <StudioField
              id="skill-description"
              label="Description"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              required
              maxLength={200}
            />
            <p className="text-[12px] text-[var(--studio-faint)]">
              Describe WHEN this applies, not what it says; this is what matching reads.
            </p>
          </div>
          <div className="space-y-8">
            <label
              htmlFor="skill-content"
              className="block text-[13px] font-medium text-[var(--studio-fg)]"
            >
              Instructions
            </label>
            <textarea
              id="skill-content"
              value={draft.content}
              onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              required
              maxLength={4000}
              rows={6}
              className="w-full rounded-12 border border-[var(--studio-line-strong)] bg-[var(--studio-surface)] px-16 py-12 text-[14px] text-[var(--studio-fg)] placeholder:text-[var(--studio-faint)] focus-visible:border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--studio-ring)]"
            />
          </div>
          <div className="flex gap-8">
            <StudioButton type="submit" variant="primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save skill'}
            </StudioButton>
            <StudioButton type="button" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </StudioButton>
          </div>
        </form>
      )}
    </section>
  );
}
