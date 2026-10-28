import { SearchQuery } from '@solus/contracts/search-query'
import { searchTargetMatches } from '@solus/contracts/session-search'
import type { Message } from '@solus/contracts/types'
import type { SearchMessageRequest } from '@solus/client-core/session-search-navigation'

/** Load bounded history pages until the requested message is available, then reveal it. */
export async function openSearchMessage(request: SearchMessageRequest, options: {
  messages(): Message[]
  hasOlder(): boolean
  loadOlder(): Promise<void>
  stillWanted(): boolean
  reveal(messageId: string, word: string): Promise<void>
}): Promise<boolean> {
  for (;;) {
    if (!options.stillWanted()) return false
    const message = options.messages().find(message => searchTargetMatches(request.target, message))
    if (message) {
      const [hit] = new SearchQuery(request.query).hits(message.content)
      await options.reveal(message.id, hit ? message.content.slice(hit.start, hit.end) : '')
      return true
    }
    if (!options.hasOlder()) return false
    const before = options.messages().length
    await options.loadOlder()
    if (options.messages().length <= before) return false
  }
}
