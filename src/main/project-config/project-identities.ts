import type { ProjectIdentity } from '../../shared/types'
import { resolveRepoRef } from '../git/git-helpers'
import { listProjects } from './projects-manifest'

export async function listProjectIdentities(): Promise<ProjectIdentity[]> {
  const projects = await listProjects()
  const identities = await Promise.all(projects.map(async (project): Promise<ProjectIdentity | null> => {
    const repo = await resolveRepoRef(project.path)
    if (!repo) return null
    return {
      path: project.path,
      folderName: project.folderName,
      repoKey: `${repo.host}/${repo.owner}/${repo.repo}`.toLowerCase(),
    }
  }))
  return identities.filter((identity): identity is ProjectIdentity => identity !== null)
}
