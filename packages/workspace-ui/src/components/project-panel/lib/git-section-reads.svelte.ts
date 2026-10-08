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
  repository: Pick<RepositorySetupStore, 'refresh' | 'refreshGithubConnection'>
}

/** Visible Git rows own details; cache writes must not restart their subscription. */
export function useGitSectionReads(reads: GitSectionReads): void {
  let requestedSetupFor: string | null = null
  $effect(() => {
    if (!reads.active || !reads.cwd || reads.cwd === '~') return
    const { api, serverId, cwd } = reads
    const key = `${serverId}\0${cwd}`
    if (requestedSetupFor === key) return
    requestedSetupFor = key
    untrack(() => { void reads.repository.refresh(api, serverId, cwd) })
  })

  let requestedConnectionFor: string | null = null
  $effect(() => {
    if (!reads.active || reads.readiness !== 'local-only' || !reads.cwd || reads.cwd === '~') return
    const { api, serverId, cwd } = reads
    const key = `${serverId}\0${cwd}`
    if (requestedConnectionFor === key) return
    requestedConnectionFor = key
    untrack(() => { void reads.repository.refreshGithubConnection(api, serverId, reads.context(), cwd) })
  })

  $effect(() => {
    if (!reads.active || !reads.cwd || reads.cwd === '~') return
    const { serverId, cwd } = reads
    return untrack(() => reads.environment.watchDetails(serverId, cwd))
  })
}
