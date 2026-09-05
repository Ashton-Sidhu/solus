import type { Message } from '@solus/contracts/types'
import type { SessionLoadMessage, SessionMessageWindow } from '@solus/contracts/session-history'

export type PreviewMessage = SessionLoadMessage | Message

export interface BoundedPreviewMessage {
  role: 'user' | 'assistant'
  snippet: string
}

export interface PreviewExtraction {
  firstUserMessage: BoundedPreviewMessage | null
  lastAssistantMessage: BoundedPreviewMessage | null
}

/** A search hit's surroundings as the host returned them, and which of the
 *  messages is the hit. */
export interface LoadedHitWindow {
  window: SessionMessageWindow
  hitMessageId: number
}

export interface HitWindowMessage {
  role: 'user' | 'assistant'
  /** The message bounded for the pane: cut around the words for the hit,
   *  from the start for its neighbours. */
  passage: string
  isHit: boolean
}

/** What a preview shows for a search hit: the hit and its neighbours in
 *  transcript order, and how much of the transcript sits either side. */
export interface HitWindow {
  messages: HitWindowMessage[]
  hiddenBefore: number
  hiddenAfter: number
}

const SNIPPET_LIMIT = 220
const HIT_PASSAGE_LIMIT = 360

/** Collapse whitespace and cut at a word boundary near `limit` — never mid-word. */
export function truncateAtWord(text: string, limit = SNIPPET_LIMIT): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= limit) return clean
  const sliced = clean.slice(0, limit)
  const lastSpace = sliced.lastIndexOf(' ')
  const cut = lastSpace > limit * 0.6 ? sliced.slice(0, lastSpace) : sliced
  return cut.replace(/[,;:\-–—]+$/, '') + '…'
}

/** Bound markdown without flattening the line breaks that give lists, quotes,
 *  headings, and fenced code their structure. */
function truncateMarkdownAtWord(text: string, limit = SNIPPET_LIMIT): string {
  const clean = text.trim()
  if (clean.length <= limit) return clean
  const sliced = clean.slice(0, limit)
  const lastWhitespace = Math.max(
    sliced.lastIndexOf(' '),
    sliced.lastIndexOf('\n'),
    sliced.lastIndexOf('\t'),
  )
  const cut = lastWhitespace > limit * 0.6 ? sliced.slice(0, lastWhitespace) : sliced
  return cut.replace(/[,;:\-–—]+$/, '') + '…'
}

/**
 * The passage of `text` around the first word of `query` it contains, with
 * ellipses where it was cut. A hit deep in a long reply must show the words
 * that were hit, not the reply's opening. When no word is found — the index
 * matched a stem the words do not spell — the head of the text is shown.
 */
export function passageAround(text: string, query: string, limit = HIT_PASSAGE_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const haystack = flat.toLowerCase()
  let at = -1
  for (const word of words) {
    const found = haystack.indexOf(word)
    if (found >= 0 && (at < 0 || found < at)) at = found
  }
  if (at < 0) return truncateAtWord(flat, limit)
  // A third of the room leads in, so the hit sits where the eye lands first.
  let start = Math.max(0, at - Math.floor(limit / 3))
  let end = Math.min(flat.length, start + limit)
  if (start > 0) {
    const space = flat.indexOf(' ', start)
    if (space >= 0 && space < at) start = space + 1
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(' ', end)
    if (space > at) end = space
  }
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** Bound a loaded hit window for the pane: the hit cut around the query's
 *  words, its neighbours cut from their start. */
export function boundHitWindow(loaded: LoadedHitWindow, query: string): HitWindow {
  return {
    messages: loaded.window.messages.map((message) =>
      message.messageId === loaded.hitMessageId
        ? { role: message.role, passage: passageAround(message.text, query), isHit: true }
        : { role: message.role, passage: truncateAtWord(message.text), isHit: false },
    ),
    hiddenBefore: loaded.window.hiddenBefore,
    hiddenAfter: loaded.window.hiddenAfter,
  }
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
      lastAssistantMessage = { role: 'assistant', snippet: truncateMarkdownAtWord(m.content || '') }
      break
    }
  }

  return { firstUserMessage, lastAssistantMessage }
}
