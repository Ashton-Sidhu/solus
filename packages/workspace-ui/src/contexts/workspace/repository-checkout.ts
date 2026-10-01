import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { serversStore } from '../connections/servers.store.svelte'
import { projectsStore, type ProjectsStore } from '../projects/projects.store.svelte'
import { hostIsManaged } from '../../components/servers/lib/managed-host'
import { cloneUrlForRepoKey } from '../../components/servers/run-on'

type CheckoutApi = Pick<HostApi, 'listProjects' | 'setupCloneProject' | 'trackRecentProject'>

/** What making a repository a project on a host needs from the world. */
export interface CheckoutHost {
  /** Resolves true once this client is connected to the host. */
  reach(serverId: string): Promise<boolean>
  api(serverId: string): CheckoutApi
  projects: Pick<ProjectsStore, 'loadProjectsFor' | 'addProject'>
}

export const liveCheckoutHost: CheckoutHost = {
  // A cloud host may be stopped, and starting one takes minutes; any other
  // machine either answers soon or is not there.
  reach: (serverId) => hostIsManaged(serversStore.hostFor(serverId))
    ? serversStore.startManagedHost(serverId, { timeoutMs: 300_000 })
    : serversStore.connectNow(serverId, { timeoutMs: 30_000 }),
  api: (serverId) => serverConnections.apiFor(serverId),
  projects: projectsStore,
}

/** `reaching` waits for the host to run and answer; `cloning` copies the repository there. */
export type CheckoutStep = 'reaching' | 'cloning'

/**
 * Make a repository a project on a host and resolve to its folder there
 * (docs/projects.md, "Cloud projects"). A checkout the host already holds is
 * used as it is, never cloned a second time. A clone is added to the project
 * list, so every surface lists it from then on. Throws with the reason a
 * person can act on.
 */
export async function ensureRepositoryCheckout(
  serverId: string,
  repositoryKey: string,
  onStep: (step: CheckoutStep) => void,
  host: CheckoutHost = liveCheckoutHost,
): Promise<string> {
  onStep('reaching')
  if (!await host.reach(serverId)) {
    throw new Error('Solus could not reach this machine. Try again, or choose another machine.')
  }
  const api = host.api(serverId)
  const known = await host.projects.loadProjectsFor(serverId, api, { force: true })
  const existing = known.find((project) => project.repositoryKey === repositoryKey)?.path
  if (existing) return existing
  const cloneUrl = cloneUrlForRepoKey(repositoryKey)
  if (!cloneUrl) throw new Error(`${repositoryKey} does not name a repository Solus can clone.`)
  onStep('cloning')
  const { path } = await api.setupCloneProject({ cloneUrl, partialClone: true })
  host.projects.addProject(serverId, api, path)
  return path
}
