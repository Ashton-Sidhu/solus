// Adapted from T3 Code apps/mobile/src/lib/threadActivity.ts (MIT, see UPSTREAM.md).
import type { TranscriptItem } from '../conversation/lib/transcript-model'

/**
 * The rows T3's thread feed shows, derived from a Solus transcript: user
 * bubbles, assistant prose, tool calls grouped into one work row per run of
 * consecutive calls, a "Worked" fold over a finished turn's work, and one live
 * "Thinking" slot while the agent works.
 *
 * Input is each row's id and kind only. Both are fixed for an id, so this runs
 * when rows are added or the turn state changes, never per streamed token: a
 * row reads its own content from the store.
 */

export interface FeedSourceEntry {
  readonly id: string
  readonly kind: TranscriptItem['kind']
  /** Notices only: an error notice marks its turn as failed, which never folds. */
  readonly tone?: 'error' | 'info'
  /** Artifacts only: the work its revisions share. */
  readonly workId?: string | null
  /** Users only: the host's own wake (a pull request watch, a background
   *  command), drawn as a notice row. It is not a person's message, so it
   *  never joins a burst. */
  readonly hostNotice?: boolean
}

export type ThreadFeedRow =
  | {
      readonly type: 'message'
      readonly id: string
      readonly role: 'user' | 'assistant'
      readonly showMeta: boolean
      /** User only: the next row is another message from the person, so the gap below closes. */
      readonly groupedWithNext?: boolean
    }
  | {
      readonly type: 'work-toggle'
      readonly id: string
      readonly groupId: string
      readonly toolIds: readonly string[]
      readonly expanded: boolean
      /** The trailing group of the working turn: it carries the live shimmer. */
      readonly live: boolean
      readonly continuesWorkLog: boolean
    }
  | { readonly type: 'work-details'; readonly id: string; readonly groupId: string; readonly toolIds: readonly string[]; readonly continuesWorkLog: boolean }
  | { readonly type: 'run-fold'; readonly id: string; readonly turnId: string; readonly label: string; readonly expanded: boolean }
  | { readonly type: 'thinking'; readonly id: string; readonly continuesWorkLog: boolean }
  | { readonly type: 'notice'; readonly id: string }
  | { readonly type: 'compaction'; readonly id: string }
  | { readonly type: 'plan'; readonly id: string }
  | { readonly type: 'worktree-offer'; readonly id: string }
  | { readonly type: 'setup'; readonly id: string }
  | { readonly type: 'mcp-app'; readonly id: string }
  /** The host handed the thread to another provider. */
  | { readonly type: 'handoff'; readonly id: string }
  /** The composer picked another provider; the next prompt hands off (plans/021). */
  | { readonly type: 'handoff-pending'; readonly id: string }
  /** All image sources below the turn reply; each item subscribes independently. */
  | { readonly type: 'turn-artifacts'; readonly id: string; readonly promptId: string | null; readonly nextPromptId: string | null; readonly imageIds: readonly string[] }
  | { readonly type: 'turn-images'; readonly id: string; readonly itemIds: readonly string[] }
  /** An HTML render. `superseded`: a later render in the feed revises the same work. */
  | { readonly type: 'artifact'; readonly id: string; readonly superseded: boolean }
  /** An app work. `superseded`: a later row in the feed revises the same work. */
  | { readonly type: 'app'; readonly id: string; readonly superseded: boolean }
  /** Consecutive agents of one turn: other Solus sessions and provider subagents. */
  | { readonly type: 'agents'; readonly id: string; readonly groupId: string; readonly itemIds: readonly string[]; readonly expanded: boolean }

export interface ThreadFeedPresentationInput {
  readonly entries: readonly FeedSourceEntry[]
  /** The last turn has not settled (running, or waiting on the person). */
  readonly turnActive: boolean
  /** The agent is producing output now: the live slot shows. */
  readonly working: boolean
  readonly expandedTurnIds: ReadonlySet<string>
  readonly expandedWorkGroupIds: ReadonlySet<string>
  /** The picked provider differs from the thread's: a pending row ends the feed. */
  readonly handoffPending?: boolean
}

/** Shared by the trailing live tool row and its Thinking fallback, so the slot keeps its key. */
export const LIVE_ACTIVITY_ROW_ID = 'live-activity-row'

export const HANDOFF_PENDING_ROW_ID = 'handoff-pending-row'

const START_TURN_ID = 'turn:start'

interface Turn {
  readonly id: string
  /** Rows after the user's prompt, in order. */
  readonly entries: FeedSourceEntry[]
}

export function deriveThreadFeedPresentation(input: ThreadFeedPresentationInput): ThreadFeedRow[] {
  const turns = splitTurns(input.entries)
  const lastTurn = turns.at(-1)
  const rows: ThreadFeedRow[] = []
  const latestRevisions = latestArtifactRevisions(input.entries)
  const hostNotices = new Set<string>()
  for (const [index, { user, turn }] of turns.entries()) {
    if (user) {
      // A prompt directly after another prompt is a burst: nothing came between them.
      const previous = rows.at(-1)
      if (!user.hostNotice && previous?.type === 'message' && previous.role === 'user' && !hostNotices.has(previous.id)) {
        rows[rows.length - 1] = { ...previous, groupedWithNext: true }
      }
      if (user.hostNotice) hostNotices.add(user.id)
      rows.push({ type: 'message', id: user.id, role: 'user', showMeta: true })
    }
    const active = input.turnActive && turn === lastTurn?.turn
    appendTurnRows(rows, turn, active, input, latestRevisions)
    // A prompt followed by another is a burst: it has no turn of its own to end.
    if (!active && turn.entries.length > 0) rows.push({
      type: 'turn-artifacts',
      id: `artifacts:${turn.id}`,
      promptId: user?.id ?? null,
      nextPromptId: turns[index + 1]?.user?.id ?? null,
      imageIds: turn.entries.filter((entry) => entry.kind === 'assistant' || entry.kind === 'image').map((entry) => entry.id),
    })
  }
  const trailing = rows.findLast((row) => row.type !== 'turn-images' && row.type !== 'turn-artifacts')
  if (input.working && !(trailing?.type === 'work-toggle' && trailing.live)) {
    rows.push({ type: 'thinking', id: LIVE_ACTIVITY_ROW_ID, continuesWorkLog: false })
  }
  if (input.handoffPending) rows.push({ type: 'handoff-pending', id: HANDOFF_PENDING_ROW_ID })
  return markContinuedWorkLogs(rows)
}

/** The newest render of each artifact work, by work id. */
function latestArtifactRevisions(entries: readonly FeedSourceEntry[]): ReadonlyMap<string, string> {
  const latest = new Map<string, string>()
  for (const entry of entries) {
    if ((entry.kind === 'artifact' || entry.kind === 'app') && entry.workId) latest.set(entry.workId, entry.id)
  }
  return latest
}

function splitTurns(entries: readonly FeedSourceEntry[]): Array<{ user: FeedSourceEntry | null; turn: Turn }> {
  const turns: Array<{ user: FeedSourceEntry | null; turn: Turn }> = []
  let current: { user: FeedSourceEntry | null; turn: Turn } | null = null
  for (const entry of entries) {
    if (entry.kind === 'user') {
      current = { user: entry, turn: { id: `turn:${entry.id}`, entries: [] } }
      turns.push(current)
      continue
    }
    if (!current) {
      current = { user: null, turn: { id: START_TURN_ID, entries: [] } }
      turns.push(current)
    }
    current.turn.entries.push(entry)
  }
  return turns
}

function appendTurnRows(
  rows: ThreadFeedRow[],
  turn: Turn,
  active: boolean,
  input: ThreadFeedPresentationInput,
  latestRevisions: ReadonlyMap<string, string>,
): void {
  const terminalAssistantId = turn.entries.findLast((entry) => entry.kind === 'assistant')?.id ?? null
  const failed = turn.entries.some((entry) => entry.kind === 'notice' && entry.tone === 'error')
  // A finished turn folds its work behind one row, progress notes included, as
  // desktop does (`buildTurns`). It keeps the final prose, anything that asks
  // for attention (plans, notices, compaction and
  // handoff dividers, worktree offers), and artifacts. Images follow the reply.
  const hidden = active || failed
    ? new Set<string>()
    : new Set(turn.entries
        .filter((entry) => entry.id !== terminalAssistantId && entry.kind !== 'plan' && entry.kind !== 'notice' && entry.kind !== 'compaction' && entry.kind !== 'handoff' && entry.kind !== 'worktree_offer' && entry.kind !== 'image' && entry.kind !== 'browser_snapshot' && entry.kind !== 'artifact' && entry.kind !== 'app' && entry.kind !== 'mcp_app' && entry.kind !== 'setup')
        .map((entry) => entry.id))
  const expandedFold = input.expandedTurnIds.has(turn.id)
  let foldPlaced = false
  let group: FeedSourceEntry[] = []
  let agents: FeedSourceEntry[] = []
  // Image cards follow the reply, outside the work fold.
  const imageIds = turn.entries.filter((entry) => entry.kind === 'assistant' || entry.kind === 'image' || entry.kind === 'browser_snapshot').map((entry) => entry.id)
  const flushAgents = () => {
    if (agents.length === 0) return
    const groupId = `agents:${agents[0]!.id}`
    rows.push({ type: 'agents', id: groupId, groupId, itemIds: agents.map((entry) => entry.id), expanded: input.expandedWorkGroupIds.has(groupId) })
    agents = []
  }
  const flushGroup = (trailing: boolean) => {
    if (group.length === 0) return
    const groupId = `work-group:${group[0]!.id}`
    const expanded = input.expandedWorkGroupIds.has(groupId)
    const live = active && trailing
    const toolIds = group.map((entry) => entry.id)
    rows.push({
      type: 'work-toggle',
      id: live ? LIVE_ACTIVITY_ROW_ID : `work-toggle:${groupId}`,
      groupId,
      toolIds,
      expanded,
      live,
      continuesWorkLog: false,
    })
    if (expanded) rows.push({ type: 'work-details', id: `work-details:${groupId}`, groupId, toolIds, continuesWorkLog: false })
    group = []
  }
  const entries = turn.entries.filter((entry) => entry.kind !== 'image' && entry.kind !== 'browser_snapshot')
  entries.forEach((entry, index) => {
    if (hidden.has(entry.id)) {
      if (!foldPlaced) {
        flushGroup(false)
        rows.push({ type: 'run-fold', id: `run-fold:${turn.id}`, turnId: turn.id, label: 'Worked', expanded: expandedFold })
        foldPlaced = true
      }
      if (!expandedFold) return
    }
    if (entry.kind === 'agent') {
      flushGroup(false)
      agents.push(entry)
      return
    }
    flushAgents()
    if (entry.kind === 'tool') {
      group.push(entry)
      if (index === entries.length - 1) flushGroup(true)
      return
    }
    flushGroup(false)
    if (entry.kind === 'assistant') {
      rows.push({ type: 'message', id: entry.id, role: 'assistant', showMeta: !active && entry.id === terminalAssistantId })
    } else if (entry.kind === 'plan') {
      rows.push({ type: 'plan', id: entry.id })
    } else if (entry.kind === 'notice') {
      rows.push({ type: 'notice', id: entry.id })
    } else if (entry.kind === 'compaction') {
      rows.push({ type: 'compaction', id: entry.id })
    } else if (entry.kind === 'worktree_offer') {
      rows.push({ type: 'worktree-offer', id: entry.id })
    } else if (entry.kind === 'setup') {
      rows.push({ type: 'setup', id: entry.id })
    } else if (entry.kind === 'mcp_app') {
      rows.push({ type: 'mcp-app', id: entry.id })
    } else if (entry.kind === 'handoff') {
      rows.push({ type: 'handoff', id: entry.id })
    } else if (entry.kind === 'artifact') {
      const superseded = !!entry.workId && latestRevisions.get(entry.workId) !== entry.id
      rows.push({ type: 'artifact', id: entry.id, superseded })
    } else if (entry.kind === 'app') {
      rows.push({ type: 'app', id: entry.id, superseded: !!entry.workId && latestRevisions.get(entry.workId) !== entry.id })
    }
  })
  flushAgents()
  flushGroup(false)
  if (imageIds.length > 0) rows.push({ type: 'turn-images', id: `images:${turn.id}`, itemIds: imageIds })
}

function isWorkLogRow(row: ThreadFeedRow | undefined): boolean {
  return row?.type === 'work-toggle' || row?.type === 'work-details' || row?.type === 'thinking'
}

/** A work row followed by another drops its bottom margin, so the log reads as one block. */
function markContinuedWorkLogs(rows: ThreadFeedRow[]): ThreadFeedRow[] {
  return rows.map((row, index) => {
    if (!isWorkLogRow(rows[index + 1])) return row
    if (row.type !== 'work-toggle' && row.type !== 'work-details' && row.type !== 'thinking') return row
    return { ...row, continuesWorkLog: true }
  })
}
