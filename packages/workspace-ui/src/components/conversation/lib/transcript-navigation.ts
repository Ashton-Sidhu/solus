import { tick } from 'svelte'
import type { Turn } from './turns'
import type { ConversationFindMatch } from './find'
import type { ConversationFindHighlighter } from './find-highlight'
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

export async function revealTranscriptMatch(options: {
  match: ConversationFindMatch
  turns: Turn[]
  turnId?: string
  expand: (turn: Turn) => void
  virtualizer: TranscriptVirtualizer
  elements: () => { messages: HTMLElement | null; scroll: HTMLElement | null }
  highlighter: ConversationFindHighlighter
  query: string
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
  const target = messages?.querySelector<HTMLElement>(
    `[data-conversation-message-id="${CSS.escape(match.messageId)}"]`,
  )
  target?.scrollIntoView({ block: 'center' })
  await tick()
  const activeRange = options.highlighter.update(messages, options.query, match)
  const activeRect = activeRange?.getBoundingClientRect()
  const scrollRect = scroll?.getBoundingClientRect()
  if (!activeRect || !scrollRect || !scroll) return
  const top = activeRect.top - scrollRect.top
  const bottom = activeRect.bottom - scrollRect.bottom
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
  if (top < 56) scroll.scrollBy({ top: top - 80, behavior })
  else if (bottom > -24) scroll.scrollBy({ top: bottom + 48, behavior })
}
