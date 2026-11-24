import { z } from 'zod'
import type { ProjectConfig, ProjectEntry } from '@solus/contracts/types'
import { codebaseNamingSchema, type Codebase } from '@solus/contracts/codebases'
import { worktreeBranchNamingSchema } from '@solus/contracts/worktree-branch-naming'
import { isInsideHostPath } from '@solus/contracts/host-path'
import { codebasesHolding, isContainerRoot } from '@solus/client-core/codebases'
import { getInstallationId } from '../../../admission/auth'
import { workspaceToolContext } from '../../../data/workspace/tool-context'
import { resolveHomePath } from '../../../platform/paths'
import type { AgentTool, AgentToolContext } from './agent-tool'
import { asPerson, type PersonCall } from './person-rpc'
import { findSession } from './session-tools'

/**
 * `list_projects`, `read_project`, `update_project`, and `delete_project`: the
 * projects of this host as the person of the turn sees and changes them from
 * Settings, the project chip, and mobile. Each tool sends the RPC that a
 * client sends, so the same rules apply: a member sees only the projects in
 * their own folder, a guest is refused, and a container root of a codebase is
 * no project (docs/plans/codebases.md decision 14).
 */

const LIST_MAX = 200
/** A delete without `force` reads at most this many sessions of the project. */
const SESSION_SAMPLE = 20

/** The codebases of this host that the person reads. A host that cannot answer has none for this list. */
async function codebasesOf(call: PersonCall): Promise<Codebase[]> {
  return call('codebaseList').catch(() => [])
}

/** The projects the person sees: their visible list, without the container roots of codebases. */
async function visibleProjects(call: PersonCall): Promise<ProjectEntry[]> {
  const [projects, codebases] = await Promise.all([call('listProjects'), codebasesOf(call)])
  const installationId = getInstallationId()
  return projects.filter((project) => !isContainerRoot(codebases, { installationId, path: project.path }))
}

/** The listed project that is `folder` or holds it, the innermost when lists nest. */
function projectHolding(projects: readonly ProjectEntry[], folder: string): ProjectEntry | null {
  return projects
    .filter((project) => isInsideHostPath(project.path, folder))
    .sort((a, b) => b.path.length - a.path.length)[0] ?? null
}

/** The folder a tool call names, else the project of the calling session. */
async function folderOf(path: string | undefined, context: AgentToolContext): Promise<string> {
  if (path?.trim()) return resolveHomePath(path.trim())
  const sessionId = context.sessionId()
  const projectPath = sessionId ? (await findSession(sessionId))?.projectPath : undefined
  return resolveHomePath(projectPath || context.cwd)
}

/** One project as the tools answer it. */
interface ProjectRow {
  path: string
  name: string
  repository: string | null
  lastUsedAt: string
}

/** One page of `list_projects`. `nextCursor` is absent on the last page. */
interface ProjectPage {
  projects: ProjectRow[]
  nextCursor?: string
}

function projectRow(project: ProjectEntry): ProjectRow {
  return { path: project.path, name: project.folderName, repository: project.repositoryKey, lastUsedAt: project.lastUsedAt }
}

const pathField = z.string().trim().min(1).optional().describe('A project folder on this host, or a folder inside one. Defaults to the project of this session.')

// ─── list_projects ───

const listFields = {
  limit: z.number().int().min(1).max(LIST_MAX).optional().describe(`Max projects, 1 to ${LIST_MAX}. Defaults to 50.`),
  cursor: z.string().regex(/^\d+$/).optional().describe('nextCursor from the last page.'),
}

export const listProjectsAgentTool: AgentTool<typeof listFields> = {
  name: 'list_projects',
  description: 'List the projects of this host that the user sees, most recently used first. Each row gives path, name, repository, and lastUsedAt. Page with cursor=nextCursor; a new project can move the rows of a page. A folder that holds the repositories of a codebase is not a project: use list_codebases.',
  inputFields: listFields,
  strictInput: true,
  requiresApproval: false,
  execute: (input, context) => asPerson('list_projects', context, async (call) => {
    const projects = await visibleProjects(call)
    const start = Number(input.cursor ?? 0)
    const end = start + (input.limit ?? 50)
    const page: ProjectPage = { projects: projects.slice(start, end).map(projectRow) }
    if (end < projects.length) page.nextCursor = String(end)
    return { ok: true, text: JSON.stringify(page), format: 'json' }
  }),
}

// ─── read_project ───

const readFields = { path: pathField }

export const readProjectAgentTool: AgentTool<typeof readFields> = {
  name: 'read_project',
  description: 'Read one project of this host: its folder, repository, the settings in its .solus/config.json, and the codebases that hold it. Omit path for the project of this session.',
  inputFields: readFields,
  strictInput: true,
  requiresApproval: false,
  execute: (input, context) => asPerson('read_project', context, async (call) => {
    const folder = await folderOf(input.path, context)
    const project = projectHolding(await visibleProjects(call), folder)
    if (!project) return { ok: false, text: `No project of this host holds ${folder}. Use list_projects.` }
    const [settings, codebases] = await Promise.all([call('projectConfigLoad', project.path), codebasesOf(call)])
    const holders = codebasesHolding(codebases, { installationId: getInstallationId(), path: project.path })
    return { ok: true, format: 'json', text: JSON.stringify({
      ...projectRow(project),
      addedAt: project.addedAt,
      settings: settings ?? { version: 1 },
      codebases: holders.map((codebase) => ({ id: codebase.id, name: codebase.name })),
    }) }
  }),
}

// ─── update_project ───

const clears = 'null removes the setting.'
const updateFields = {
  path: pathField,
  task_done_on_merge: z.boolean().nullable().optional().describe(`Move a task to done when its linked pull request merges. ${clears}`),
  worktree_branch_naming: worktreeBranchNamingSchema.nullable().optional().describe(`Overrides the host's worktree branch naming. ${clears}`),
  codebase_naming: codebaseNamingSchema.nullable().optional().describe(`How Solus names a codebase that it makes from this project and a second one. ${clears}`),
  server_urls: z.array(z.string()).nullable().optional().describe(`Local preview addresses (http://localhost:...). Replaces the list. ${clears}`),
  ignore_repositories: z.array(z.string().min(1)).nullable().optional().describe(`Repositories inside this folder that a codebase does not cover, relative to the folder. Replaces the list. ${clears}`),
  worktree_layout: z.object({ create: z.string().trim().min(1), remove: z.string().trim().min(1).optional() }).nullable().optional()
    .describe(`Shell commands that make and remove the task folder of a session in this folder. ${clears}`),
}
type SettingKey = Exclude<keyof ProjectConfig, 'version'>

/** Set one setting of `config`, or remove it for null. Answers whether the call named it. */
function applySetting<K extends SettingKey>(config: ProjectConfig, key: K, value: ProjectConfig[K] | null | undefined): boolean {
  if (value === undefined) return false
  if (value === null) delete config[key]
  else config[key] = value
  return true
}

export const updateProjectAgentTool: AgentTool<typeof updateFields> = {
  name: 'update_project',
  description: 'Change the settings of one project in its .solus/config.json, as Settings does. Omitted fields do not change; null removes a setting. The file is in the repository, so the change shows in Git. For deviceRuns, edit the file. Omit path for the project of this session. Returns the new settings.',
  inputFields: updateFields,
  strictInput: true,
  requiresApproval: true,
  execute: (input, context) => asPerson('update_project', context, async (call) => {
    const folder = await folderOf(input.path, context)
    const project = projectHolding(await visibleProjects(call), folder)
    if (!project) return { ok: false, text: `No project of this host holds ${folder}. Use list_projects.` }
    const next: ProjectConfig = { ...await call('projectConfigLoad', project.path) ?? { version: 1 } }
    const named = [
      applySetting(next, 'taskDoneOnMerge', input.task_done_on_merge),
      applySetting(next, 'worktreeBranchNaming', input.worktree_branch_naming),
      applySetting(next, 'codebaseNaming', input.codebase_naming),
      applySetting(next, 'serverUrls', input.server_urls),
      applySetting(next, 'ignoreRepositories', input.ignore_repositories),
      applySetting(next, 'worktreeLayout', input.worktree_layout),
    ]
    if (!named.includes(true)) return { ok: false, text: 'Give at least one setting to change.' }
    const settings = await call('projectConfigSave', project.path, next)
    return { ok: true, text: JSON.stringify({ path: project.path, settings }), format: 'json' }
  }),
}

// ─── delete_project ───

const deleteFields = {
  path: z.string().trim().min(1).describe('The project folder on this host, as list_projects gives it.'),
  force: z.boolean().optional().describe('Required when sessions work in the project. The sessions stay.'),
}

/** The sessions in the person's list that work in the project folder or its worktrees, up to `SESSION_SAMPLE`. */
async function sessionsInProject(projectPath: string, callerSessionId: string | undefined): Promise<number> {
  const { operations, context } = await workspaceToolContext(callerSessionId)
  const page = await operations.listSessions(context, { scope: 'all', projectPath, includeWorktrees: 'true', limit: SESSION_SAMPLE })
  return page.items.length
}

export const deleteProjectAgentTool: AgentTool<typeof deleteFields> = {
  name: 'delete_project',
  description: 'Remove one project from the project list of this host, as Remove does in the project chip. The folder, its files, its sessions, and its tasks stay; adding the folder again lists it again. A project that has sessions needs force: true.',
  inputFields: deleteFields,
  strictInput: true,
  requiresApproval: true,
  execute: (input, context) => asPerson('delete_project', context, async (call) => {
    const folder = resolveHomePath(input.path)
    const project = projectHolding(await visibleProjects(call), folder)
    if (!project) return { ok: false, text: `No project of this host holds ${folder}. Use list_projects.` }
    if (project.path !== folder) return { ok: false, text: `${folder} is inside the project ${project.path}. Give the project folder as path.` }
    if (!input.force) {
      const sessions = await sessionsInProject(project.path, context.sessionId())
      if (sessions > 0) {
        const count = sessions >= SESSION_SAMPLE ? `${SESSION_SAMPLE} or more sessions` : `${sessions} session${sessions === 1 ? '' : 's'}`
        return { ok: false, text: `${count} work in ${project.path}. The sessions stay after the delete. To remove the project, call again with force: true.` }
      }
    }
    await call('untrackProject', project.path)
    return { ok: true, text: JSON.stringify({ path: project.path, deleted: true, folderKept: true }), format: 'json' }
  }),
}
