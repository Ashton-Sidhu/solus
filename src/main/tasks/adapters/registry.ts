import type { ExternalTicketRef } from '../../../shared/task-types'
import { loadProjectConfig } from '../../project-config/project-config'
import { GitHubTaskSyncAdapter } from './github'
import type { TaskSyncAdapter } from './types'

const adapters = new Map<ExternalTicketRef['provider'], TaskSyncAdapter>([
  ['github', new GitHubTaskSyncAdapter()],
])

export function taskSyncAdapter(provider: string): TaskSyncAdapter {
  const adapter = provider === 'github' ? adapters.get('github') : undefined
  if (!adapter) throw new Error(`Task sync provider "${provider}" is not supported.`)
  return adapter
}

export interface TaskPublishTarget {
  adapter: TaskSyncAdapter
  ref: Omit<ExternalTicketRef, 'externalId' | 'url'>
}

/** Resolve a project's configured upstream. The setting selects a publish and
 * import target; it does not transfer ownership of native task rows. */
export async function resolveTaskPublishTarget(cwd: string): Promise<TaskPublishTarget | null> {
  const config = await loadProjectConfig(cwd)
  if ((config?.taskProvider ?? 'local') === 'local') return null
  if (config?.taskProvider !== 'github') {
    throw new Error(`Task sync provider "${config?.taskProvider}" is not supported.`)
  }
  const configuredOwner = config.taskProviderConfig?.owner?.trim()
  const configuredRepo = config.taskProviderConfig?.repo?.trim()
  const detected = configuredOwner && configuredRepo
    ? null
    : await import('../../git/git-helpers').then(({ resolveRepoRef }) => resolveRepoRef(cwd))
  const owner = configuredOwner ?? detected?.owner
  const repo = configuredRepo ?? detected?.repo
  if (!owner || !repo) {
    throw new Error('GitHub task sync needs a configured repository or a GitHub origin remote.')
  }
  return {
    adapter: taskSyncAdapter('github'),
    ref: { provider: 'github', externalKey: `${owner}/${repo}` },
  }
}
