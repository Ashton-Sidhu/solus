import { tick } from 'svelte'
import type { Turn } from './turns'
import type { ConversationFindMatch } from './find'
import type { TranscriptVirtualizer } from './transcript-virtualizer.svelte'

export function messageTurnIds(turns: Turn[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const turn of turns) {
    for (const item of [...(turn.lead ? [turn.lead] : []), ...turn.body, ...turn.tail]) {
      if ('message' in item) result.set(item.message.id, turn.id)
      else for (const message of item.messages) result.set(message.id, turn.id)
    }
  }
  return result
}

/*
 * Mount the match's turn, then center the match, as browser find does. The
 * composer floats over the bottom of the scroll area, so a match that is only
 * inside the scroll area can still be hidden.
 */
export async function revealTranscriptMatch(options: {
  match: ConversationFindMatch
  turns: Turn[]
  turnId?: string
  expand: (turn: Turn) => void
  virtualizer: TranscriptVirtualizer
  elements: () => { messages: HTMLElement | null; scroll: HTMLElement | null }
  /** Paints the find highlights and returns the active match, when on screen. */
  highlight: (messages: HTMLElement | null) => Range | null
}): Promise<void> {
  const { match, turnId } = options
  if (!turnId) return
  const turn = options.turns.find((candidate) => candidate.id === turnId)
  if (turn && !turn.live && turn.body.some((item) => 'message' in item
    ? item.message.id === match.messageId
    : item.messages.some((message) => message.id === match.messageId))) {
    options.expand(turn)
    await tick()
  }
  await options.virtualizer.reveal(turnId)
  const { messages, scroll } = options.elements()
  const target = options.highlight(messages) ?? messages?.querySelector<HTMLElement>(
    `[data-conversation-message-id="${CSS.escape(match.messageId)}"]`,
  )
  if (!target || !scroll) return
  const rect = target.getBoundingClientRect()
  const view = scroll.getBoundingClientRect()
  const offset = rect.top + rect.height / 2 - (view.top + view.height / 2)
  scroll.scrollBy({ top: offset, behavior: 'instant' })
}
