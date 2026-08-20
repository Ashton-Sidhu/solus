import type { Message } from '@solus/contracts/types'
import { stripInjectedContext } from '@solus/contracts/injected-context'

/** Prefer the mounted transcript, but accept the host index when a session row
 * exists before its conversation view has loaded. */
export function sessionTitleRegenerationInput(
  messages: Array<Pick<Message, 'content' | 'role'>>,
  indexedFirstMessage?: string | null,
): string | null {
  const transcriptPrompt = messages.find(
    (message) => message.role === 'user' && message.content.trim(),
  )?.content
  const visibleTranscriptPrompt = transcriptPrompt
    ? stripInjectedContext(transcriptPrompt).trim()
    : ''
  if (visibleTranscriptPrompt) return visibleTranscriptPrompt

  const visibleIndexedPrompt = indexedFirstMessage
    ? stripInjectedContext(indexedFirstMessage).trim()
    : ''
  return visibleIndexedPrompt || null
}
