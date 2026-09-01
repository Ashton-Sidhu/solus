import type { Message } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'

export type PreviewMessage = SessionLoadMessage | Message

export interface BoundedPreviewMessage {
  role: 'user' | 'assistant'
  snippet: string
}

export interface PreviewExtraction {
  firstUserMessage: BoundedPreviewMessage | null
  lastAssistantMessage: BoundedPreviewMessage | null
}

const SNIPPET_LIMIT = 220

/** Collapse whitespace and cut at a word boundary near `limit` — never mid-word. */
export function truncateAtWord(text: string, limit = SNIPPET_LIMIT): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= limit) return clean
  const sliced = clean.slice(0, limit)
  const lastSpace = sliced.lastIndexOf(' ')
  const cut = lastSpace > limit * 0.6 ? sliced.slice(0, lastSpace) : sliced
  return cut.replace(/[,;:\-–—]+$/, '') + '…'
}

function isToolCall(m: PreviewMessage): boolean {
  return 'toolName' in m && !!m.toolName
}

function isMeaningful(m: PreviewMessage): boolean {
  if (m.role !== 'user' && m.role !== 'assistant') return false
  if (isToolCall(m)) return false
  if (!(m.content || '').trim()) return false
  return true
}

/**
 * Bound a full/partial transcript down to the two messages a picker preview
 * shows: the first meaningful user message and the last meaningful assistant
 * reply. Scans from each end and stops at the first match, so cost tracks the
 * distance to that message rather than total transcript length.
 */
export function extractPreviewMessages(
  messages: PreviewMessage[] | null | undefined,
): PreviewExtraction {
  if (!messages || messages.length === 0) {
    return { firstUserMessage: null, lastAssistantMessage: null }
  }

  let firstUserMessage: BoundedPreviewMessage | null = null
  for (const m of messages) {
    if (m.role === 'user' && isMeaningful(m)) {
      firstUserMessage = { role: 'user', snippet: truncateAtWord(m.content || '') }
      break
    }
  }

  let lastAssistantMessage: BoundedPreviewMessage | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && isMeaningful(m)) {
      lastAssistantMessage = { role: 'assistant', snippet: truncateAtWord(m.content || '') }
      break
    }
  }

  return { firstUserMessage, lastAssistantMessage }
}
