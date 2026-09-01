import type { ExternalTicketRef } from '@solus/contracts/task-types'
import type { ProjectConfig } from '@solus/contracts/types'
import { connectedSite } from '../../atlassian/api'
import { resolveRepoRef } from '../../git/git-helpers'
import { loadProjectConfig } from '../../project-config/project-config'
import { GitHubTaskSyncAdapter } from './github'
import { JiraTaskSyncAdapter } from './jira'
import { assetReferencesIn, type AssetReference } from '../task-assets'
import type { TaskSyncAdapter } from './types'

/** Every provider the sync engine can speak to. An adapter names its own id, so
 *  registering one is adding it here and nothing else. */
const adapters: TaskSyncAdapter[] = [
  new GitHubTaskSyncAdapter(),
  new JiraTaskSyncAdapter(),
]

export function taskSyncAdapter(provider: string): TaskSyncAdapter {
  const adapter = adapters.find((candidate) => candidate.id === provider)
  if (!adapter) throw new Error(`Task sync provider "${provider}" is not supported.`)
  return adapter
}

/**
 * References that stop a body from being sent upstream. With no linked provider
 * every reference blocks, because nothing can host the bytes; with one, only the
 * types that provider refuses do.
 */
export function blockedAssetReferences(body: string, provider: string | null): AssetReference[] {
  const references = assetReferencesIn(body)
  if (!references.length || !provider) return references
  return taskSyncAdapter(provider).unpublishableAssets(body)
}

export interface TaskPublishTarget {
  adapter: TaskSyncAdapter
  ref: Omit<ExternalTicketRef, 'externalId' | 'url'>
}

/** Resolve a project's configured upstream. The setting selects a publish and
 * import target; it does not transfer ownership of native task rows. */
export async function resolveTaskPublishTarget(cwd: string): Promise<TaskPublishTarget | null> {
  const config = await loadProjectConfig(cwd)
  const provider = config?.taskProvider ?? 'local'
  if (provider === 'local') return null
  if (provider === 'github') return githubTarget(cwd, config)
  if (provider === 'jira') return jiraTarget(config)
  throw new Error(`Task sync provider "${provider}" is not supported.`)
}

async function githubTarget(cwd: string, config: ProjectConfig | null): Promise<TaskPublishTarget> {
  const underlyingRepo = await resolveRepoRef(cwd)
  if (!underlyingRepo || underlyingRepo.host.toLowerCase() !== 'github.com') {
    throw new Error('GitHub task sync needs a GitHub origin remote for this project.')
  }
  const configuredOwner = config?.taskProviderConfig?.owner?.trim()
  const configuredRepo = config?.taskProviderConfig?.repo?.trim()
  if (!configuredOwner || !configuredRepo) {
    throw new Error('GitHub task sync is not bound. Bind it to this project\'s GitHub origin first.')
  }
  if (configuredOwner !== underlyingRepo.owner || configuredRepo !== underlyingRepo.repo) {
    throw new Error(
      `GitHub task sync is bound to ${configuredOwner}/${configuredRepo}, but this project uses ${underlyingRepo.owner}/${underlyingRepo.repo}. Rebind GitHub to the underlying repository.`,
    )
  }
  return {
    adapter: taskSyncAdapter('github'),
    ref: { provider: 'github', externalKey: `${underlyingRepo.owner}/${underlyingRepo.repo}` },
  }
}

/**
 * Jira has nothing to detect: no checkout names a Jira project, so the project
 * key is always an explicit choice. The cloudId is the site the project was
 * bound to, which stays in the config so a persisted `<cloudId>/<projectKey>`
 * key keeps meaning the same thing after the connection changes.
 */
async function jiraTarget(config: ProjectConfig | null): Promise<TaskPublishTarget> {
  const projectKey = config?.taskProviderConfig?.projectKey?.trim()
  if (!projectKey) {
    throw new Error('Jira task sync needs a project. Choose one for this project first.')
  }
  const cloudId = config?.taskProviderConfig?.cloudId?.trim()
    ?? (await connectedSite('jira'))?.cloudId
  if (!cloudId) {
    throw new Error('Connect Atlassian to use Jira task sync.')
  }
  return {
    adapter: taskSyncAdapter('jira'),
    ref: { provider: 'jira', externalKey: `${cloudId}/${projectKey}` },
  }
}
