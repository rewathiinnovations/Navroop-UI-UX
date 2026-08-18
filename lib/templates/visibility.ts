export type TemplateVisibilityRow = {
  workspaceId: string | null;
  isActive: boolean;
};

export function memberTemplateWhere(workspaceId: string) {
  return {
    isActive: true,
    OR: [{ workspaceId: null }, { workspaceId }],
  };
}

export function isVisibleToWorkspace(
  template: TemplateVisibilityRow,
  workspaceId: string,
  opts?: { includeInactive?: boolean },
) {
  if (!opts?.includeInactive && !template.isActive) return false;
  return template.workspaceId == null || template.workspaceId === workspaceId;
}
