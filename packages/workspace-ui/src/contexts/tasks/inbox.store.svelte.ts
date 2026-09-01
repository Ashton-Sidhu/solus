import { serverConnections } from '@solus/client-core/server-connections'
import type { InboxInvolvement } from '@solus/contracts/inbox-types'
import { SvelteMap } from 'svelte/reactivity'
import { untrack } from 'svelte'
import {
  mergeInboxPullRequests,
  mergeInboxTickets,
  type InboxHostScope,
} from '../../components/tasks/lib/inbox-merge'

const INVOLVEMENT_KEY = 'solus.taskInbox.involvement'
const INVOLVEMENTS: readonly InboxInvolvement[] = [
  'assigned', 'review_requested', 'mentioned', 'authored', 'all',
]

function initialInvolvement(): InboxInvolvement {
  const stored = globalThis.localStorage?.getItem(INVOLVEMENT_KEY) ?? null
  return isInboxInvolvement(stored) ? stored : 'assigned'
}

function isInboxInvolvement(value: string | null): value is InboxInvolvement {
  return INVOLVEMENTS.some((involvement) => involvement === value)
}

export class InboxStore {
  involvement = $state<InboxInvolvement>(initialInvolvement())
  loading = $state(false)
  hostErrors = new SvelteMap<string, string>()
  scopes = $state<InboxHostScope[]>([])
  private loadEpoch = 0

  tickets = $derived(mergeInboxTickets(this.scopes))
  pullRequests = $derived(mergeInboxPullRequests(this.scopes))

  setInvolvement(involvement: InboxInvolvement): void {
    this.involvement = involvement
    globalThis.localStorage?.setItem(INVOLVEMENT_KEY, involvement)
  }

  async load(): Promise<void> {
    const epoch = ++this.loadEpoch
    this.loading = true
    // `load()` is called from the page-entry effect. These are request inputs,
    // not effect dependencies: tracking `scopes` here made every completed
    // request change the effect and immediately start another one forever.
    const previousScopes = untrack(() => this.scopes)
    const involvement = untrack(() => this.involvement)
    try {
      const serverIds = serverConnections.connectedServerIds()
      const results = await Promise.all(serverIds.map(async (serverId) => {
        const phase = serverConnections.phaseFor(serverId)
        if (phase !== 'connected') {
          return { serverId, error: `Host is ${phase}.` }
        }
        try {
          const result = await serverConnections.apiFor(serverId).inboxListUpstream(involvement)
          return { serverId, scopes: result.scopes }
        } catch (error) {
          return { serverId, error: error instanceof Error ? error.message : String(error) }
        }
      }))
      if (epoch !== this.loadEpoch) return
      this.hostErrors.clear()
      const scopes: InboxHostScope[] = []
      for (const result of results) {
        if ('error' in result) {
          this.hostErrors.set(result.serverId, result.error)
          scopes.push(...previousScopes
            .filter((scope) => scope.serverId === result.serverId)
            .map((scope) => ({ ...scope, fromCache: true })))
        }
        else scopes.push(...result.scopes.map((scope) => ({ ...scope, serverId: result.serverId })))
      }
      this.scopes = scopes
    } catch (error) {
      if (epoch === this.loadEpoch) {
        this.hostErrors.set('inbox', error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (epoch === this.loadEpoch) this.loading = false
    }
  }
}

export const inboxStore = new InboxStore()
