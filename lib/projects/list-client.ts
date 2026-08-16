export type ProjectPhase = "PLANNING" | "BUILDING" | "COMPLETE";

export type ListProject = {
  id: string;
  name: string;
  thumbnailUrl: string | null;
  status: string;
  phase?: ProjectPhase | null;
  createdAt?: string;
  updatedAt: string;
  ownerId: string;
  owner?: { name: string | null; avatarUrl?: string | null } | null;
  starred?: boolean;
};

export type ProjectListQuery = {
  search?: string;
  sort?: string;
  mine?: boolean;
  starred?: boolean;
};

export function isProjectGenerating(project: Pick<ListProject, "phase">) {
  return project.phase === "PLANNING" || project.phase === "BUILDING";
}

export function buildProjectsApiUrl(query: ProjectListQuery) {
  const params = new URLSearchParams();
  const search = query.search?.trim();
  if (search) params.set("search", search);
  if (query.sort) params.set("sort", query.sort);
  if (query.mine === true) params.set("mine", "true");
  if (query.mine === false) params.set("mine", "false");
  if (query.starred) params.set("starred", "true");
  const qs = params.toString();
  return qs ? `/api/projects?${qs}` : "/api/projects";
}

export async function fetchProjectList(query: ProjectListQuery = {}) {
  const response = await fetch(buildProjectsApiUrl(query));
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false as const,
      status: response.status,
      error: String(data.error || "Could not load projects"),
    };
  }
  return {
    ok: true as const,
    projects: (data.projects || []) as ListProject[],
  };
}

const DAY_MS = 86_400_000;

export type DateBucket = {
  heading: string;
  items: ListProject[];
};

export function bucketProjectsByUpdatedAt(projects: ListProject[]): DateBucket[] {
  const now = Date.now();
  const last14: ListProject[] = [];
  const last60: ListProject[] = [];
  const older: ListProject[] = [];

  for (const project of projects) {
    const age = now - new Date(project.updatedAt).getTime();
    if (Number.isNaN(age) || age <= 14 * DAY_MS) last14.push(project);
    else if (age <= 60 * DAY_MS) last60.push(project);
    else older.push(project);
  }

  return [
    { heading: "Last 14 days", items: last14 },
    { heading: "Last 60 days", items: last60 },
    { heading: "Older", items: older },
  ].filter((bucket) => bucket.items.length > 0);
}

export function projectInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "P";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

export function initialsGradient(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `linear-gradient(135deg, hsl(${hue} 62% 58%), hsl(${(hue + 42) % 360} 54% 46%))`;
}
