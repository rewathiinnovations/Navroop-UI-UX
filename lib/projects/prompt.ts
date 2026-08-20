export function looksLikeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  return /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}([/?#].*)?$/i.test(trimmed);
}

export function titleFromPrompt(prompt: string) {
  const cleaned = prompt.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Untitled project';
  return cleaned.length > 48 ? `${cleaned.slice(0, 48)}…` : cleaned;
}

/** API returns `name`; older clients still read `title`. */
export function projectDisplayName(
  project:
    | {
        name?: string | null;
        title?: string | null;
      }
    | null
    | undefined,
) {
  return (project?.name || project?.title || '').trim();
}
