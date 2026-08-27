/**
 * The authorization classification of every `'use server'` export (F-313).
 *
 * Data only, and shared on purpose. Two suites consume it:
 *
 *   - `tests/unit/server-action-authz.test.ts` binds each id to the real module,
 *     proves the enumeration is complete against the filesystem, and then RUNS
 *     every export to prove the classification (401 signed out, 403 for a MEMBER
 *     on an `admin` export, 403 for a non-owner MEMBER on an `owner` one).
 *   - `tests/unit/mutating-route-authz.test.ts` classifies all of `app/api/**`
 *     and, for every route that is a thin wrapper over one of these actions,
 *     requires the two classifications to agree. About half the mutating API
 *     surface delegates, so those routes inherit a gate that is proved by
 *     running it rather than by matching source text.
 *
 * Keeping the table here is what makes those two claims claims about one object.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `admin`   — `requireAdmin`; a signed-in MEMBER must be refused with 403.
 * `owner`   — scoped to one row; a MEMBER who does not own it must get 403.
 * `session` — signed-in only, no check on any target. Legitimate for a
 *             workspace-wide read (Navroop is a single workspace, see
 *             `lib/auth/route-policy.ts`) or an action that derives its target
 *             from the session, but it always needs a `why`.
 * `none`    — no authorization at all. Every entry is a live finding.
 */
export type Gate = 'admin' | 'owner' | 'session' | 'none';

export type ExportAuthz = {
  gate: Gate;
  /** Call arguments. Generic unless validation runs before the gate. */
  args?: unknown[];
  /** Required for `session`/`none` on a project-scoped or mutating export. */
  why?: string;
};

export type ModuleAuthz = {
  /** Repo-relative path without extension; must match a discovered module. */
  id: string;
  exports: Record<string, ExportAuthz>;
};

/** Arguments for an export whose gate runs before it reads anything. */
export const DEFAULT_ACTION_ARGS: unknown[] = ['id-1', 'arg-2'];

const TEMPLATE_INPUT = {
  name: 'Template',
  description: 'A template saved from a project',
  category: 'business',
  prompt: 'Build a small marketing site with a hero, services and contact form.',
};

export const ACTION_AUTHZ: ModuleAuthz[] = [
  {
    id: 'lib/api-keys/actions',
    exports: {
      listPersonalApiKeys: { gate: 'session' },
      listOrgApiKeys: { gate: 'admin' },
      setPersonalApiKey: {
        gate: 'session',
        args: ['openai', 'placeholder'],
        why: 'writes the caller\u2019s own row; the user id comes from the session, never from an argument',
      },
      setOrgApiKey: { gate: 'admin', args: ['openai', 'placeholder'] },
      deleteOrgApiKey: { gate: 'admin', args: ['openai'] },
      deleteApiKey: {
        gate: 'session',
        args: ['openai'],
        why: 'deletes the caller\u2019s own personal key; target is the session user id',
      },
    },
  },
  {
    id: 'lib/assets/actions',
    exports: {
      listProjectAssets: { gate: 'owner' },
      generateProjectImage: { gate: 'owner', args: ['proj-1', 'a hero image', '16:9'] },
      searchProjectStock: { gate: 'owner', args: ['proj-1', 'mountains'] },
      uploadProjectAsset: { gate: 'owner', args: ['proj-1', new FormData()] },
      updateProjectAssetAlt: { gate: 'owner', args: ['proj-1', 'asset-1', 'alt text'] },
      deleteProjectAsset: { gate: 'owner', args: ['proj-1', 'asset-1'] },
    },
  },
  {
    id: 'lib/audit/actions',
    exports: {
      isCodeScanInFlight: { gate: 'owner' },
      runCodeAudit: { gate: 'owner' },
      runAutoCodeAudit: { gate: 'owner' },
      getLatestCodeAudit: {
        gate: 'session',
        why: 'workspace-wide read: the audit panel is visible to any member of the single workspace, and the row holds no secret. The ownership answer is owed by the mutations and by the in-flight probe, which have it.',
      },
      toggleIgnoreCodeFinding: { gate: 'owner' },
      fixCodeFinding: { gate: 'owner' },
      fixAllCodeFindings: { gate: 'owner' },
      getTopRecurringIssues: { gate: 'admin', args: [8] },
    },
  },
  {
    id: 'lib/coolify/actions',
    exports: {
      getDeploySettings: { gate: 'admin' },
      saveDeploySettings: { gate: 'admin', args: [{ baseUrl: 'https://coolify.navroop.app' }] },
      testDeployConnection: { gate: 'admin' },
    },
  },
  {
    id: 'lib/coolify/server-actions',
    exports: {
      listCoolifyServers: { gate: 'admin' },
      createCoolifyServer: { gate: 'admin' },
      updateCoolifyServer: { gate: 'admin' },
      forceDeactivateServer: { gate: 'admin' },
      deleteCoolifyServer: { gate: 'admin' },
      testCoolifyServerAction: { gate: 'admin' },
    },
  },
  {
    id: 'lib/domains/actions',
    exports: {
      listProjectDomains: {
        gate: 'session',
        why: 'workspace-wide read by decision recorded in lib/domains/actions.ts:59-60 — the verify token is the only field held back, and it is withheld from a caller who could not mutate the domain',
      },
      addProjectDomain: {
        gate: 'owner',
        args: ['proj-1', { hostname: 'app.example.com', path: 'A' }],
      },
      checkProjectDomain: { gate: 'owner', args: ['proj-1', 'domain-1'] },
      makeProjectDomainPrimary: { gate: 'owner', args: ['proj-1', 'domain-1'] },
      removeProjectDomain: { gate: 'owner', args: ['proj-1', 'domain-1', 'app.example.com'] },
      emailProjectDomain: { gate: 'owner', args: ['proj-1', 'domain-1', 'ops@example.invalid'] },
    },
  },
  {
    id: 'lib/github/actions',
    exports: {
      disconnectGitHub: {
        gate: 'session',
        why: 'disconnects the caller\u2019s own connection; the user id comes from the session. The two exports that took a target from their arguments were deleted rather than gated (see the file header).',
      },
      pushProjectToGitHub: { gate: 'owner' },
    },
  },
  {
    id: 'lib/memory/actions',
    exports: {
      createMemory: {
        gate: 'owner',
        args: [{ scope: 'PROJECT', projectId: 'proj-1', category: 'design', content: 'note' }],
      },
      updateMemory: { gate: 'owner', args: ['memory-1', 'edited note'] },
      archiveMemory: { gate: 'owner', args: ['memory-1'] },
      reactivateMemory: { gate: 'owner', args: ['memory-1'] },
      listMemories: {
        gate: 'session',
        args: [{ scope: 'PROJECT', projectId: 'proj-1' }],
        why: 'workspace-wide read of the Brain panel; memory rows are shared context for the single workspace, and every write is owner- or admin-gated',
      },
      listBrainMemories: {
        gate: 'session',
        why: 'workspace-wide read, same panel as listMemories',
      },
      getMemoryBudget: {
        gate: 'session',
        why: 'workspace-wide read: returns the token budget of the block that listBrainMemories already shows',
      },
      getMemoryExtractionSetting: { gate: 'admin' },
      updateMemoryExtractionSetting: { gate: 'admin', args: [true] },
    },
  },
  {
    id: 'lib/plans/actions',
    exports: {
      listPlans: { gate: 'admin' },
      createPlan: { gate: 'admin' },
      updatePlan: { gate: 'admin' },
      assignDefaultWorkspacePlan: { gate: 'admin' },
      getWorkspaceAdminSettings: { gate: 'admin' },
      updateWorkspaceAdminSettings: { gate: 'admin' },
      getCreditMeter: {
        gate: 'session',
        why: 'reads the single workspace\u2019s own credit meter, which the header shows to every member; takes no target id',
      },
      getUsageBreakdown: {
        gate: 'session',
        why: 'reads the single workspace\u2019s own usage rollup; takes no target id',
      },
    },
  },
  {
    id: 'lib/profile/actions',
    exports: {
      updateProfile: {
        gate: 'session',
        args: [{ name: 'Renamed Member' }],
        why: 'edits the caller\u2019s own user row; the id comes from requireSessionUser, never from the input',
      },
      uploadAvatar: {
        gate: 'session',
        args: [new FormData()],
        why: 'writes the caller\u2019s own avatar; target is the session user id',
      },
      changePassword: {
        gate: 'session',
        args: ['old-secret-value', 'new-secret-value'],
        why: 'changes the caller\u2019s own password and re-verifies the current one; target is the session user id',
      },
    },
  },
  {
    id: 'lib/projects/actions',
    exports: {
      createProject: {
        gate: 'session',
        args: [{ initialPrompt: 'build a landing page' }],
        why: 'creates a new row owned by the caller; ownerId is taken from the session, so there is no pre-existing target to check',
      },
      listProjects: {
        gate: 'session',
        args: [{}],
        why: 'workspace-wide list: Navroop is a single workspace and the dashboard shows every project in it',
      },
      getProject: {
        gate: 'session',
        why: 'workspace-wide read, same surface as listProjects; every mutation on the row is owner-gated',
      },
      updateProject: { gate: 'owner', args: ['proj-1', { name: 'Renamed' }] },
      deleteProject: { gate: 'owner' },
      restoreProject: { gate: 'owner' },
      duplicateProject: { gate: 'owner' },
      persistProjectGeneration: { gate: 'owner', args: ['proj-1', {}] },
    },
  },
  {
    id: 'lib/projects/stars',
    exports: {
      // The N-009 export. Hand-listing is what let it ship ungated; it is now
      // reached because the enumeration comes from the module object.
      toggleStar: { gate: 'owner' },
      getRecentProjects: {
        gate: 'session',
        args: [5],
        why: 'workspace-wide read, same surface as listProjects',
      },
      getWorkspaceMeta: { gate: 'session' },
    },
  },
  {
    id: 'lib/publish/actions',
    exports: {
      getPublishState: {
        gate: 'session',
        why: 'workspace-wide read of publish status and the slug this project would claim; every publish, password and teardown action below is owner-gated',
      },
      startPublish: { gate: 'owner', args: ['proj-1', 'PREVIEW'] },
      retryPublish: { gate: 'owner', args: ['proj-1', 'PREVIEW'] },
      setPreviewPasswordAction: { gate: 'owner', args: ['proj-1', null] },
      listWorkspaceDeployments: {
        gate: 'session',
        why: 'workspace-wide read: the /deployments page lists the single workspace\u2019s deployments',
      },
      stopDeploymentAction: { gate: 'owner', args: ['deployment-1'] },
      redeployAction: { gate: 'owner', args: ['deployment-1'] },
      listDeploymentReleasesAction: { gate: 'owner', args: ['deployment-1'] },
      rollbackDeploymentAction: { gate: 'owner', args: ['deployment-1', 'sha-1', 'roll back'] },
      deleteDeploymentAction: { gate: 'owner', args: ['deployment-1', 'slug-1'] },
    },
  },
  {
    id: 'lib/seo/actions',
    exports: {
      isSeoScanInFlight: { gate: 'owner' },
      runSeoAudit: { gate: 'owner' },
      runAutoSeoAudit: { gate: 'owner' },
      getLatestSeoAudit: {
        gate: 'session',
        why: 'workspace-wide read; the twin of getLatestCodeAudit and the same argument applies',
      },
      toggleIgnoreFinding: { gate: 'owner' },
      fixSeoFinding: { gate: 'owner' },
      fixAllSeoFindings: { gate: 'owner' },
    },
  },
  {
    id: 'lib/skills/actions',
    exports: {
      listSkills: { gate: 'session' },
      createSkill: { gate: 'admin' },
      updateSkill: { gate: 'admin' },
      deleteSkill: { gate: 'admin' },
      toggleSkillEnabled: { gate: 'admin' },
    },
  },
  {
    id: 'lib/team/actions',
    exports: {
      listTeam: { gate: 'admin' },
      updateMemberRole: { gate: 'admin', args: ['user-2', 'MEMBER'] },
      deactivateMember: { gate: 'admin', args: ['user-2'] },
      reactivateMember: { gate: 'admin', args: ['user-2'] },
    },
  },
  {
    id: 'lib/templates/actions',
    exports: {
      listTemplates: { gate: 'session', args: [{}] },
      getTemplate: { gate: 'session' },
      createFromTemplate: {
        gate: 'session',
        args: ['template-1', {}],
        why: 'creates a new project owned by the caller from a workspace-visible template; the template is checked for visibility, and there is no pre-existing target row to own',
      },
      previewSaveAsTemplate: { gate: 'owner' },
      saveProjectAsTemplate: { gate: 'owner', args: ['proj-1', TEMPLATE_INPUT] },
      adminListTemplates: { gate: 'admin', args: [{}] },
      adminCreateTemplate: { gate: 'admin' },
      adminUpdateTemplate: { gate: 'admin' },
      adminDeleteTemplate: { gate: 'admin' },
      adminTestTemplate: { gate: 'admin' },
      adminUploadThumbnail: { gate: 'admin', args: ['template-1', Buffer.from('x')] },
      adminGenerateThumbnails: { gate: 'admin' },
    },
  },
];

const SOURCE_ROOTS = ['app', 'components', 'lib', 'types'];
const SKIP_DIRS: Record<string, true> = {
  node_modules: true,
  '.next': true,
  '.git': true,
  generated: true,
};

/**
 * A `'use server'` directive may sit under a leading licence or block comment,
 * so the scan tolerates comments before it — but nothing else. A directive that
 * is not the first statement is not a directive at all.
 */
const USE_SERVER = /^\uFEFF?\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*['"]use server['"]/;

function walkSources(dir: string, out: string[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS[entry.name]) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkSources(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
}

/** Repo-relative, forward-slashed, extension stripped — matches `ModuleAuthz.id`. */
export function discoverUseServerModules(root: string = process.cwd()): string[] {
  const files: string[] = [];
  for (const dir of SOURCE_ROOTS) {
    const full = join(root, dir);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    walkSources(full, files);
  }
  return files
    .filter((file) => USE_SERVER.test(readFileSync(file, 'utf8')))
    .map((file) =>
      file
        .slice(root.length + 1)
        .replace(/\\/g, '/')
        .replace(/\.tsx?$/, ''),
    )
    .sort();
}

/**
 * First parameter name of each exported function, read from source. Used to spot
 * project-scoped exports without trusting the registry's own claim about them.
 */
export function firstParamNames(moduleId: string): Record<string, string> {
  const source = readFileSync(join(process.cwd(), `${moduleId}.ts`), 'utf8');
  const found: Record<string, string> = {};
  const declaration = /export\s+(?:async\s+)?function\s+(\w+)\s*\(([\s\S]{0,120}?)[,:)]/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(source)) !== null) {
    found[match[1]] = match[2].trim();
  }
  return found;
}

/**
 * Names that read as a state change. Anything matching this may only be
 * `session` with a written justification — the check that would have stopped
 * `toggleStar` from being classified as "just needs a session" (N-009).
 */
export const MUTATION_VERB =
  /^(add|archive|assign|change|create|delete|disconnect|duplicate|email|fix|force|generate|make|persist|push|reactivate|redeploy|remove|restore|retry|run|save|set|start|stop|toggle|update|upload)/;

/**
 * Exports classified `session` or `none` that are project-scoped or read as a
 * mutation and carry no `why`. The N-009 shape, allowed only in writing.
 */
export function unjustifiedTargets(module: ModuleAuthz): string[] {
  const params = firstParamNames(module.id);
  const unjustified: string[] = [];
  for (const [name, entry] of Object.entries(module.exports)) {
    if (entry.gate === 'admin' || entry.gate === 'owner') continue;
    const projectScoped = params[name] === 'projectId';
    const mutating = MUTATION_VERB.test(name);
    if ((projectScoped || mutating) && !entry.why?.trim()) {
      unjustified.push(
        `${name} (${entry.gate}, ${projectScoped ? 'takes projectId' : 'name reads as a mutation'})`,
      );
    }
  }
  return unjustified;
}

/** Classification of one export, or undefined when it is not registered. */
export function actionAuthz(moduleId: string, exportName: string): ExportAuthz | undefined {
  return ACTION_AUTHZ.find((entry) => entry.id === moduleId)?.exports[exportName];
}
