import { untrack } from 'svelte'
import type { HostApi } from '@solus/client-core/host-api'
import type { IpcContext } from '@solus/contracts/types'
import type { SessionEnvironmentStore } from '../../../contexts/git/session-environment.store.svelte'
import type { RepositorySetupStore } from '../../../contexts/git/repository-setup.store.svelte'
import type { GitReadiness } from './git-action-selection'

interface GitSectionReads {
  readonly active: boolean
  readonly serverId: string
  readonly cwd: string
  readonly api: HostApi
  readonly readiness: GitReadiness
  context(): IpcContext
  environment: Pick<SessionEnvironmentStore, 'watchDetails'>
  repository: Pick<RepositorySetupStore, 'ensure' | 'ensureGithubConnection'>
}

/** Visible Git rows own details; cache writes must not restart their subscription.
 *  The repository status and GitHub connection are read once per checkout by
 *  the store, so a Git section that mounts again on a tab switch reads none. */
export function useGitSectionReads(reads: GitSectionReads): void {
  $effect(() => {
    if (!reads.active || !reads.cwd || reads.cwd === '~') return
    const { api, serverId, cwd } = reads
    untrack(() => reads.repository.ensure(api, serverId, cwd))
  })

  $effect(() => {
    if (!reads.active || reads.readiness !== 'local-only' || !reads.cwd || reads.cwd === '~') return
    const { api, serverId, cwd } = reads
    untrack(() => reads.repository.ensureGithubConnection(api, serverId, reads.context(), cwd))
  })

  $effect(() => {
    if (!reads.active || !reads.cwd || reads.cwd === '~') return
    const { serverId, cwd } = reads
    return untrack(() => reads.environment.watchDetails(serverId, cwd))
  })
}
