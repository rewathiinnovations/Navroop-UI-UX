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
export function projectDisplayName(project: {
  name?: string | null;
  title?: string | null;
} | null | undefined) {
  return (project?.name || project?.title || '').trim();
}

export function relativeTime(value: string | Date) {
  const date = typeof value === 'string' ? new Date(value) : value;
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60000);
  if (Number.isNaN(minutes)) return '';
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return date.toLocaleDateString();
}
