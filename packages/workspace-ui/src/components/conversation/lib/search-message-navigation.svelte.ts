import { untrack } from 'svelte'
import { sessionSearchNavigation } from '@solus/client-core/session-search-navigation'
import { openSearchMessage } from './search-message-navigation'

/** Owns a view's pending search navigation, without tracking transcript tokens. */
export class SearchMessageNavigation {
  opening = $state(false)
  private revision = $state(0)
  constructor(options: Parameters<typeof openSearchMessage>[1] & {
    hostId(): string | null
    sessionId(): string
    ready(): boolean
    unavailable(error?: Error): void
  }) {
    $effect(() => sessionSearchNavigation.subscribe(() => { this.revision++ }))
    $effect(() => {
      void this.revision
      const hostId = options.hostId()
      const sessionId = options.sessionId()
      if (!options.ready() || !hostId || this.opening) return
      const request = sessionSearchNavigation.take(hostId, sessionId)
      if (!request) return
      untrack(() => {
        this.opening = true
        void openSearchMessage(request, options)
          .then(found => { if (!found && options.stillWanted()) options.unavailable() })
          .catch(error => options.unavailable(error instanceof Error ? error : new Error(String(error))))
          .finally(() => { this.opening = false })
      })
    })
  }
}
