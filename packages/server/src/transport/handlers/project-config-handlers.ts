import { listProjectIdentities } from '../../project-config/project-identities'
import { loadProjectConfig, saveProjectConfig } from '../../project-config/project-config'
import { deleteProject, listProjects, recordProject, untrackProject } from '../../project-config/projects-manifest'
import type { SolusServer } from '../server'
import { resolveRepositoryKey } from '../../git/git-helpers'
import { registerWorkspaceProjectHandlers } from './workspace-project-handlers'
import { projectsVisibleTo } from './setup-handlers'
import { formContainerCodebases } from '../../execution/sessions/session-codebase-formation'
import { readAgentHistoryProjects } from '../../files/agent-history'
import { claudeConfigDir } from '../../execution/agents/claude/claude-agent'
import { hostCodexHome } from '../../execution/seats/seat-login'
import { join } from 'node:path'

export function registerProjectConfigHandlers(server: SolusServer): void {
  server.register('projectConfigLoad', (args) => {
    const [cwd] = args
    return loadProjectConfig(cwd)
  })
  server.register('projectConfigSave', async (args, ctx) => {
    const [cwd, config] = args
    const saved = await saveProjectConfig(cwd, config)
    await recordProject(cwd).catch(() => {})
    await formContainerCodebases(cwd, ctx.actor)
    return saved
  })
  // A member's listings are their own workspace (managed-hosts.md §3): a project
  // the picker offers is one they may clone into or open as theirs.
  // Each entry names its repository, so a client groups checkouts of one
  // project across hosts by what they are, not by where they sit.
  server.register('listProjects', async (_args, ctx) => {
    const visible = projectsVisibleTo(ctx.principal, await listProjects())
    return Promise.all(visible.map(async (project) => ({
      ...project,
      repositoryKey: await resolveRepositoryKey(project.path),
    })))
  })
  server.register('listProjectIdentities', async (_args, ctx) => projectsVisibleTo(ctx.principal, await listProjectIdentities()))
  // The host's own provider homes, where the CLIs keep the person's threads (docs/plans/one-page-onboarding.md §3.2).
  server.register('agentHistoryProjects', async () => readAgentHistoryProjects({
    roots: { claudeProjects: join(claudeConfigDir(), 'projects'), codexSessions: join(hostCodexHome(), 'sessions') },
    projectPaths: new Set((await listProjects().catch(() => [])).map((project) => project.path)),
  }))
  registerWorkspaceProjectHandlers(server)
  server.register('deleteProject', (args) => {
    const [projectPath] = args
    return deleteProject(projectPath)
  })
  // Untracking deletes nothing, so whoever may add and see a project may take
  // it off the list: a member only within their own folder (managed-hosts.md §3).
  server.register('untrackProject', (args, ctx) => {
    const [projectPath] = args
    if (projectsVisibleTo(ctx.principal, [{ path: projectPath }]).length === 0) {
      throw new Error('This project is outside your projects folder')
    }
    return untrackProject(projectPath)
  })
}
