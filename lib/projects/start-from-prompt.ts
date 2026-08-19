import type { DesignDirectionId } from '@/lib/design/directions';
import { DEFAULT_IMPORT_MODE, type ImportMode } from '@/lib/import/mode';
import { looksLikeUrl } from '@/lib/projects/prompt';
import type { StackId } from '@/lib/stacks';

/** Where a project's arm lives, for exactly as long as it takes the workspace to open. */
export function projectArmKey(projectId: string) {
  return `navroop_arm_${projectId}`;
}

/**
 * "I just created this project from this prompt — open it and get on with it."
 *
 * The handoff used to be four sessionStorage keys that belonged to no project in particular:
 * `navroopPrompt`, `targetUrl`, `autoStart`, `navroopImportMode`. Both halves of that misfired,
 * and both cost money, because the arm ends in a generation:
 *
 *   - The workspace consumed `navroopPrompt` for whatever project its URL pointed at, so an
 *     arm for project A auto-sent A's prompt into project B if B was what opened next.
 *   - An arm that no workspace mount ever got round to reading — a failed project fetch, a
 *     back button, a second tab — stayed in the tab. `targetUrl` + `autoStart` were then read
 *     on the *next* workspace mount and auto-started a paid build on a project the user had
 *     merely opened, from the previous project's URL.
 *
 * So it is keyed by project id and taken exactly once. URL imports are not armed at all:
 * `createProject` writes the `ImportSource` row, and the workspace resumes from that (source
 * URL, import mode, and "no code yet" all come off the project), which is authoritative in a
 * way a browser key never was.
 */
export function armProjectGeneration(projectId: string, prompt: string) {
  if (typeof window === 'undefined') return;
  const text = prompt.trim();
  if (!text || looksLikeUrl(text)) return;
  sessionStorage.setItem(projectArmKey(projectId), text);
}

/**
 * Hands the arm over and forgets it. Removed before the caller acts on it, so a re-render, a
 * second mount under StrictMode, or a remounted workspace cannot send it twice.
 */
export function takeProjectArm(projectId: string): string | null {
  if (typeof window === 'undefined') return null;
  const key = projectArmKey(projectId);
  const armed = sessionStorage.getItem(key);
  if (armed === null) return null;
  sessionStorage.removeItem(key);
  return armed.trim() ? armed : null;
}

export async function createProjectFromPrompt(
  prompt: string,
  stack: StackId,
  designDirection?: DesignDirectionId,
  importMode: ImportMode = DEFAULT_IMPORT_MODE,
) {
  const response = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, status: 'idle', stack, designDirection, importMode }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false as const,
      status: response.status,
      error: String(data.error || 'Could not create project'),
    };
  }
  const project = data.project as { id: string };
  armProjectGeneration(project.id, prompt);
  return { ok: true as const, project };
}
