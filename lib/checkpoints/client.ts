import type { Checkpoint } from '@/components/workspace/types';

type CheckpointPayload = {
  id: string;
  label: string;
  thumbnailUrl: string | null;
  createdAt: string;
  isBookmarked?: boolean;
  snapshotPruned?: boolean;
};

function toCheckpoint(row: CheckpointPayload): Checkpoint {
  return {
    id: row.id,
    label: row.label,
    thumbnailUrl: row.thumbnailUrl,
    createdAt: row.createdAt,
    isBookmarked: Boolean(row.isBookmarked),
    snapshotPruned: Boolean(row.snapshotPruned),
  };
}

async function readJson(response: Response) {
  return (await response.json().catch(() => null)) as {
    checkpoints?: CheckpointPayload[];
    checkpoint?: CheckpointPayload;
    error?: string;
  } | null;
}

export async function fetchCheckpoints(projectId: string): Promise<Checkpoint[]> {
  const response = await fetch(`/api/projects/${projectId}/checkpoints`);
  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data?.error || 'Could not load version history');
  }
  return (data?.checkpoints ?? []).map(toCheckpoint);
}

export async function previewCheckpoint(projectId: string, checkpointId: string) {
  const response = await fetch(`/api/projects/${projectId}/checkpoints/${checkpointId}/preview`, {
    method: 'POST',
  });
  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data?.error || 'Could not preview this version');
  }
  return data?.checkpoint ? toCheckpoint(data.checkpoint) : null;
}

export async function exitCheckpointPreview(projectId: string) {
  const response = await fetch(`/api/projects/${projectId}/checkpoints/exit`, {
    method: 'POST',
  });
  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data?.error || 'Could not return to the current version');
  }
  return data?.checkpoint ? toCheckpoint(data.checkpoint) : null;
}

export async function toggleCheckpointBookmark(projectId: string, checkpointId: string) {
  const response = await fetch(`/api/projects/${projectId}/checkpoints/${checkpointId}/bookmark`, {
    method: 'POST',
  });
  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data?.error || 'Could not bookmark this version');
  }
  return data?.checkpoint ? toCheckpoint(data.checkpoint) : null;
}

export async function restoreCheckpoint(projectId: string, checkpointId: string) {
  const response = await fetch(`/api/projects/${projectId}/checkpoints/${checkpointId}/restore`, {
    method: 'POST',
  });
  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data?.error || 'Could not restore this version');
  }
  return data?.checkpoint ? toCheckpoint(data.checkpoint) : null;
}
