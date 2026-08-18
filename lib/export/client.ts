export async function downloadProjectZip(projectId: string, checkpointId?: string) {
  const params = checkpointId ? `?checkpointId=${encodeURIComponent(checkpointId)}` : '';
  const response = await fetch(`/api/projects/${projectId}/export${params}`);
  if (response.status === 429) {
    return { ok: false as const, error: 'Export limit reached — try again in an hour' };
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { ok: false as const, error: String(data.error || 'Could not export project') };
  }

  const blob = await response.blob();
  const header = response.headers.get('Content-Disposition') || '';
  const match = header.match(/filename="([^"]+)"/);
  const filename = match?.[1] || 'project.zip';
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { ok: true as const, bytes: blob.size, filename };
}

export function formatExportBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
