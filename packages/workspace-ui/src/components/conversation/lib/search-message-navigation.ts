import { searchTargetMatches, searchTokens, searchWords, searchTokenMatches } from '@solus/contracts/session-search'
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
      const words = searchWords(request.query)
      const token = searchTokens(message.content).find(token => words.some(word => searchTokenMatches(token.text, word)))
      await options.reveal(message.id, token ? message.content.slice(token.start, token.end) : '')
      return true
    }
    if (!options.hasOlder()) return false
    const before = options.messages().length
    await options.loadOlder()
    if (options.messages().length <= before) return false
  }
}
