import type { SessionLoadMessage } from '@solus/contracts/session-history'

/**
 * A session's transcript as `read_session` pages it, in T3 Code's timeline
 * model: every visible row is an item at a fixed position, the `messages` view
 * keeps the user and assistant messages and plans, and `activity` keeps every
 * item. A tool call and its result are one item. Rows inside a subagent belong
 * to that subagent and are not on the timeline.
 */

export type TimelineView = 'messages' | 'activity'

export type TimelineItemType =
  | 'user_message'
  | 'assistant_message'
  | 'proposed_plan'
  | 'reasoning'
  | 'tool'
  | 'subagent'
  | 'notification'

/** One item before its text is cut to a page. */
interface TimelineEntry {
  position: number
  itemId: string
  type: TimelineItemType
  status: 'running' | 'completed' | 'error' | null
  title: string | null
  text: string | null
  timestamp: number
}

export interface TimelineItem {
  position: number
  itemId: string
  type: TimelineItemType
  status: 'running' | 'completed' | 'error' | null
  title: string | null
  text: string | null
  textTruncated: boolean
  nextTextOffset: number | null
  at: string | null
}

export interface TimelinePage {
  items: TimelineItem[]
  /** Every item on the timeline, in both views. */
  itemCount: number
  nextPosition: number | null
  hasMore: boolean
}

export interface TimelineRequest {
  view: TimelineView
  /** Items after this position; -1 reads from the start. */
  afterPosition: number
  limit: number
  maxCharsPerItem: number
  /** Read this item only, from `textOffset`. */
  itemId?: string
  textOffset?: number
}

const MESSAGE_TYPES: ReadonlySet<TimelineItemType> = new Set(['user_message', 'assistant_message', 'proposed_plan'])

/**
 * The id of a message row. Claude history rows carry no provider id, so their
 * id is the role and time; `search_sessions` names a passage with the same id.
 */
export function messageItemId(role: string, messageId: string | null | undefined, timestamp: number): string {
  return messageId || `${role}@${timestamp}`
}

function buildTimeline(messages: readonly SessionLoadMessage[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  const toolsById = new Map<string, TimelineEntry>()
  for (const message of messages) {
    if (message.parentToolUseId) continue
    const tool = message.toolResultForId ? toolsById.get(message.toolResultForId) : undefined
    if (message.role === 'tool_result' && tool) {
      attachResult(tool, message)
      continue
    }
    const entry = entryOf(message)
    if (!entry) continue
    const placed = { ...entry, position: entries.length }
    entries.push(placed)
    if (message.role === 'tool' && message.toolId) toolsById.set(message.toolId, placed)
  }
  return entries
}

/** The type of a row that is only text. */
function textType(role: string): TimelineItemType | null {
  if (role === 'user') return 'user_message'
  if (role === 'assistant') return 'assistant_message'
  return role === 'reasoning' ? 'reasoning' : null
}

/** A row as a timeline item; null for a row with nothing to read. */
function entryOf(message: SessionLoadMessage): Omit<TimelineEntry, 'position'> | null {
  const base = { itemId: messageItemId(message.role, message.messageId, message.timestamp), status: null, title: null, timestamp: message.timestamp }
  const type = textType(message.role)
  if (type) return message.content.trim() ? { ...base, type, text: message.content } : null
  switch (message.role) {
    case 'plan':
      return { ...base, type: 'proposed_plan', title: message.planFilePath || null, text: message.planContent ?? message.content }
    case 'tool':
      return {
        ...base,
        itemId: message.toolId || base.itemId,
        type: message.isSubagent ? 'subagent' : 'tool',
        status: message.toolStatus ?? null,
        title: message.toolName ?? null,
        // Codex keeps a command's output on the tool row itself.
        text: [message.toolInput, message.content].filter(Boolean).join('\n') || null,
      }
    case 'tool_result':
      // A result whose call is not on the timeline.
      return { ...base, type: 'tool', status: resultStatus(message), text: message.content || null }
    default:
      // System rows: a compaction, a host activity, or a provider notice.
      return {
        ...base,
        type: 'notification',
        title: message.compaction ? 'context_compaction' : message.activity?.kind ?? null,
        text: message.content || null,
      }
  }
}

function attachResult(tool: TimelineEntry, result: SessionLoadMessage): void {
  if (result.content) tool.text = tool.text ? `${tool.text}\n${result.content}` : result.content
  tool.status = resultStatus(result)
}

function resultStatus(result: SessionLoadMessage): 'completed' | 'error' {
  return result.toolResultIsError ? 'error' : 'completed'
}

/** One page of the timeline, each item's text cut to `maxCharsPerItem`. */
export function readTimeline(messages: readonly SessionLoadMessage[], request: TimelineRequest): TimelinePage {
  const timeline = buildTimeline(messages)
  const matching = request.itemId !== undefined
    ? timeline.filter((entry) => entry.itemId === request.itemId)
    : timeline.filter((entry) => entry.position > request.afterPosition && (request.view === 'activity' || MESSAGE_TYPES.has(entry.type)))
  const page = matching.slice(0, request.limit)
  const offset = request.itemId !== undefined ? request.textOffset ?? 0 : 0
  return {
    items: page.map((entry) => clip(entry, offset, request.maxCharsPerItem)),
    itemCount: timeline.length,
    nextPosition: page.at(-1)?.position ?? null,
    hasMore: matching.length > page.length,
  }
}

function clip(entry: TimelineEntry, offset: number, maxChars: number): TimelineItem {
  const end = offset + maxChars
  const textTruncated = entry.text !== null && entry.text.length > end
  return {
    position: entry.position,
    itemId: entry.itemId,
    type: entry.type,
    status: entry.status,
    title: entry.title,
    text: entry.text === null ? null : entry.text.slice(offset, end),
    textTruncated,
    nextTextOffset: textTruncated ? end : null,
    at: Number.isFinite(entry.timestamp) ? new Date(entry.timestamp).toISOString() : null,
  }
}
