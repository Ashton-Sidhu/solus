import type { SolusServer } from '../server'
import { addWorkspaceProject, listWorkspaceProjects, removeWorkspaceProject, updateWorkspaceProject } from '../../projects/workspace-projects'
import { organizationForNew } from '../../admission/principal'

export function registerWorkspaceProjectHandlers(server: SolusServer): void {
  // The organization's project directory (docs/plans/project-model.md §2).
  // Every member reads and adds; a project is found by its repository, so an
  // add is safe to repeat. The person who adds it owns it: an update or a
  // removal needs `project.edit`, which the gate checks (docs/plans/access-model.md §2.3).
  server.register('workspaceProjectList', async (_args, ctx) => listWorkspaceProjects(ctx.actor))
  server.register('workspaceProjectAdd', async (args, ctx) => {
    const [request] = args
    const author = ctx.principal.kind === 'org-member' ? ctx.principal.userId : null
    return addWorkspaceProject(organizationForNew(ctx.principal), request, ctx.actor, author)
  })
  server.register('workspaceProjectUpdate', async (args, ctx) => {
    const [projectId, patch] = args
    return updateWorkspaceProject(ctx.actor, projectId, patch)
  })
  server.register('workspaceProjectRemove', async (args, ctx) => {
    const [projectId] = args
    await removeWorkspaceProject(ctx.actor, projectId)
  })
}
