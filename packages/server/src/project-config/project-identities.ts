import type { ProjectIdentity } from '@solus/contracts/types'
import { repositoryKeyFromRemoteUrl } from '@solus/contracts/repository-key'
import { runAsync } from '../git/exec'
import { listProjects } from './projects-manifest'

/** The clone source of each project: its `origin`, reduced by the §1 URL rule
 *  (docs/plans/project-model.md). For a fork this is the fork, not the
 *  upstream that names the project, because a dispatch clones the fork. */
export async function listProjectIdentities(): Promise<ProjectIdentity[]> {
  const projects = await listProjects()
  const identities = await Promise.all(projects.map(async (project): Promise<ProjectIdentity | null> => {
    const origin = await runAsync('git', ['remote', 'get-url', 'origin'], project.path).catch(() => null)
    const repoKey = origin ? repositoryKeyFromRemoteUrl(origin) : null
    return repoKey ? { path: project.path, folderName: project.folderName, repoKey } : null
  }))
  return identities.filter((identity): identity is ProjectIdentity => identity !== null)
}
