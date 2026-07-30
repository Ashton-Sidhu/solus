import type { Message } from '../../../../shared/types'
import { isAgentNotice, isNoReplyNotice } from '../../../contexts/workspace/session.utils'

export type GroupedItem =
  | { kind: 'user'; message: Message }
  | { kind: 'assistant'; message: Message }
  | { kind: 'live-assistant'; id: string; content: string; settledMessageId?: string }
  | { kind: 'system'; message: Message }
  | { kind: 'tool-group'; messages: Message[] }
  | { kind: 'subagent-group'; messages: Message[] }
  | { kind: 'plan'; message: Message }
  | { kind: 'document'; message: Message }
  | { kind: 'automation'; message: Message }
  | { kind: 'task'; message: Message }
  | { kind: 'relay-group'; messages: Message[] }
  | { kind: 'artifact'; message: Message }

export function groupMessages(messages: Message[]): GroupedItem[] {
  const result: GroupedItem[] = []
  let toolBuf: Message[] = []
  let subagentBuf: Message[] = []
  // The turn's relay cards stack at the position of the FIRST dispatch, in
  // dispatch order, even though tool rows interleave between them in the raw
  // transcript (each prompt_session is a tool call followed by its relay
  // message). Tool rows therefore do NOT close the stack — only real prose or
  // a new turn does. The open group's array is grown in place.
  let relayGroup: Message[] | null = null
  const flushTools = () => {
    if (toolBuf.length > 0) {
      result.push({ kind: 'tool-group', messages: [...toolBuf] })
      toolBuf = []
    }
  }
  const flushSubagents = () => {
    if (subagentBuf.length > 0) {
      result.push({ kind: 'subagent-group', messages: [...subagentBuf] })
      subagentBuf = []
    }
  }
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.subMessages) {
      // Consecutive sub-agents share one compact surface instead of repeating
      // card chrome for every member of an orchestrated batch.
      flushTools()
      subagentBuf.push(msg)
    } else if (msg.role === 'tool') {
      flushSubagents()
      toolBuf.push(msg)
    } else if (msg.relayRef) {
      flushTools()
      flushSubagents()
      if (relayGroup) {
        relayGroup.push(msg)
      } else {
        relayGroup = [msg]
        result.push({ kind: 'relay-group', messages: relayGroup })
      }
    } else {
      flushTools()
      flushSubagents()
      relayGroup = null
      // The SDK writes its interrupt notice back as a user turn to keep the
      // provider transcript well-formed. Nobody typed it, so it renders as a
      // transient row, not a bubble.
      if (msg.role === 'user' && isAgentNotice(msg.content)) result.push({ kind: 'system', message: msg })
      else if (msg.role === 'user') result.push({ kind: 'user', message: msg })
      // A turn the provider was told not to answer arrives as assistant text.
      // It is the same transient state as an interrupt, so it takes the same row
      // rather than being printed as the turn's answer.
      else if (msg.role === 'assistant' && isNoReplyNotice(msg.content)) result.push({ kind: 'system', message: msg })
      else if (msg.workRef) result.push({ kind: 'document', message: msg })
      else if (msg.automationRef) result.push({ kind: 'automation', message: msg })
      else if (msg.taskRef) result.push({ kind: 'task', message: msg })
      else if (msg.artifact) result.push({ kind: 'artifact', message: msg })
      else if (msg.role === 'assistant') result.push({ kind: 'assistant', message: msg })
      else if (msg.role === 'plan') result.push({ kind: 'plan', message: msg })
      else result.push({ kind: 'system', message: msg })
    }
  }
  flushTools()
  flushSubagents()
  return result
}

export function itemKey(item: GroupedItem): string {
  if (item.kind === 'tool-group') return `tg-${item.messages[0].id}`
  if (item.kind === 'subagent-group') return `sg-${item.messages[0].id}`
  if (item.kind === 'relay-group') return `rg-${item.messages[0].id}`
  if (item.kind === 'live-assistant') return item.id
  return item.message.id
}

/** Empty provider placeholders occupy transcript history but render nothing.
 * They must not earn a disclosure caret on an otherwise empty turn. */
export function hasVisibleTurnBody(turn: Turn): boolean {
  return turn.body.some((item) => {
    if (item.kind === 'live-assistant') return !!item.content.trim()
    if (item.kind === 'assistant') return !!item.message.content.trim()
    if (item.kind === 'tool-group' || item.kind === 'subagent-group') return item.messages.length > 0
    return true
  })
}

/**
 * §17 — a run that ends before its last step always says so, and the row that
 * says it also carries the retry. `cause` is the compact text after the em
 * dash; `detail` is the complete provider error, verbatim and never paraphrased.
 * §1's third transient ending, `no-reply`, needs neither: the state is the whole
 * statement.
 */
export type TurnEnd = {
  kind: 'stopped' | 'failed' | 'no-reply'
  cause: string
  detail: string
  timestamp: number
}

/**
 * §16 — a finished turn is one activity row and the answer. The split is a
 * single cut through the transcript, never a re-ordering: `body` is the slice
 * the chevron hides and `tail` is the slice that stays, both in the order they
 * happened. Expanding puts the transcript back exactly as it was.
 */
export type Turn = {
  id: string
  lead: GroupedItem | null
  body: GroupedItem[]
  /** Actionable result cards that remain on screen while `body` is folded. */
  visibleWhenCollapsed: GroupedItem[]
  tail: GroupedItem[]
  /** Every tool call the turn made — drives the glyphs and the changed files. */
  tools: Message[]
  /** The session is still working on this turn, so it folds nothing. */
  live: boolean
  end: TurnEnd | null
  startedAt: number
}

const ERROR_RE = /^Error:\s*/
const DEAD_RE = /^Session ended unexpectedly/

/** "Failed at step 5 — codemod exited 1": four words, taken from the agent's own
 *  first line rather than written for it. */
function shortCause(text: string): string {
  const first = text.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  return first.length > 64 ? `${first.slice(0, 61)}…` : first
}

function turnEndFor(message: Message): TurnEnd | null {
  const content = message.content.trim()
  // Nothing stopped and nothing failed — the turn simply had nothing to say, so
  // it states that rather than borrowing the words for a stop.
  if (isNoReplyNotice(content)) {
    return { kind: 'no-reply', cause: '', detail: '', timestamp: message.timestamp }
  }
  if (isAgentNotice(content)) {
    const text = content.replace(/^\[/, '').replace(/\]$/, '')
    const cause = /by user/i.test(text)
      ? 'by you'
      : text.replace(/^request (interrupted|cancelled|canceled)\s*/i, '').trim() || 'cancelled'
    return { kind: 'stopped', cause, detail: '', timestamp: message.timestamp }
  }
  if (DEAD_RE.test(content)) {
    return {
      kind: 'failed',
      cause: shortCause(content),
      detail: content,
      timestamp: message.timestamp,
    }
  }
  if (ERROR_RE.test(content)) {
    const body = content.replace(ERROR_RE, '')
    return {
      kind: 'failed',
      cause: shortCause(body),
      detail: body.trim(),
      timestamp: message.timestamp,
    }
  }
  return null
}

/** Providers print a terminal error as ordinary assistant text *and* report it
 *  again as the run's error — the 529 arrives as a message and as a result. The
 *  failed row already carries the detail verbatim, so rendering the echo below
 *  it is the same fact told twice. */
function echoesEnd(item: GroupedItem, end: TurnEnd | null): boolean {
  if (end?.kind !== 'failed') return false
  const text =
    item.kind === 'assistant' ? item.message.content
    : item.kind === 'live-assistant' ? item.content
    : null
  return text !== null && text.trim() === end.detail
}

/** A fork or a move into a worktree is a statement about the thread, not
 *  something that happened inside a turn — so it opens one rather than sitting
 *  in one, and no fold can ever swallow it. Provider switches are deliberately
 *  absent: they are seamless implementation details. */
function isDivider(item: GroupedItem): boolean {
  if (item.kind !== 'system') return false
  const { forkSourceSessionId, worktreeMovedTo } = item.message
  return !!(forkSourceSessionId || worktreeMovedTo)
}

const OUTPUT_KINDS = new Set<GroupedItem['kind']>(['assistant', 'live-assistant'])
const COLLAPSE_EXCLUDED_KINDS = new Set<GroupedItem['kind']>([
  'artifact',
  'automation',
  'document',
  'relay-group',
])

/**
 * Cut the transcript into turns at each user message, then cut each turn once:
 * everything up to its final assistant output is `body`, the rest is `tail`.
 * A finished turn shows the tail and folds the body behind its row — prose, tool
 * calls, sub-agents and intermediate cards. Rendered artifacts, automations,
 * created sessions, and work cards remain visible because they are outcomes of
 * the turn rather than implementation steps.
 *
 * One cut, never a re-ordering: expanding hands back the same transcript in the
 * same order. A live turn puts everything in `body` and hides nothing — the view
 * renders that block undecorated, exactly the transcript it always was, because
 * collapsing is what *ends* a turn.
 */
export function buildTurns(items: GroupedItem[], opts: { running: boolean }): Turn[] {
  const bodies: GroupedItem[][] = []
  const turns: Turn[] = []

  const open = (lead: GroupedItem | null, id: string) => {
    turns.push({
      id,
      lead,
      body: [],
      visibleWhenCollapsed: [],
      tail: [],
      tools: [],
      live: false,
      end: null,
      startedAt: 0,
    })
    bodies.push([])
  }

  for (const item of items) {
    if (item.kind === 'user' || isDivider(item)) {
      open(item, itemKey(item))
      continue
    }
    if (turns.length === 0) open(null, `turn-head-${itemKey(item)}`)
    bodies[bodies.length - 1].push(item)
  }

  // Liveness follows the run, not the last turn: a steered prompt opens a turn
  // without ending the one it interrupted, so mark back from the end until the
  // prompt that actually started the run. Everything since is still being worked
  // on, and a turn still being worked on folds nothing.
  if (opts.running) {
    for (let i = turns.length - 1; i >= 0; i--) {
      turns[i].live = true
      const lead = turns[i].lead
      if (lead?.kind !== 'user' || lead.message.delivery !== 'steer') break
    }
  }

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    const isLive = turn.live
    const body = bodies[i]

    for (const item of body) {
      if (item.kind === 'tool-group' || item.kind === 'subagent-group') {
        turn.tools.push(...item.messages)
      }
    }

    // Only a notice at the very end closed the run; one in the middle is a
    // transient row the transcript keeps. The row states what stopped the run,
    // so the notice it came from is not also rendered — that would be the same
    // fact told twice.
    const last = body[body.length - 1]
    const endIndex = last?.kind === 'system' && turnEndFor(last.message) ? body.length - 1 : -1
    if (endIndex >= 0 && last.kind === 'system') turn.end = turnEndFor(last.message)

    // Walk back over the answer to find where it starts. The absorbed notice is
    // not rendered at all, so it cannot end the answer.
    let tailStart = endIndex >= 0 ? endIndex : body.length
    while (tailStart > 0 && OUTPUT_KINDS.has(body[tailStart - 1].kind)) tailStart--

    // One cut, so both slices keep the order they happened in.
    //
    // A live turn puts everything in `body` — not in `tail` — so that ending it
    // moves only the answer between the two blocks. Were it the other way round,
    // the whole turn would change `{#each}` at the fold and Svelte would destroy
    // and rebuild every subtree in it (markdown re-parse, code blocks, artifacts,
    // entry animations) in a single frame. `body` is hidden, never unmounted.
    const cut = isLive ? body.length : tailStart
    for (let j = 0; j < body.length; j++) {
      if (j === endIndex) continue
      const item = body[j]
      // Retrying reuses the same user turn. If an earlier attempt was stopped or
      // failed, its terminal notice remains in the provider transcript; it is
      // superseded by the latest ending and must not reappear as "hidden work"
      // when the reader opens this turn's disclosure.
      if (endIndex >= 0 && item.kind === 'system' && turnEndFor(item.message)) continue
      if (echoesEnd(item, turn.end)) continue
      if (j < cut) {
        turn.body.push(item)
        if (COLLAPSE_EXCLUDED_KINDS.has(item.kind)) {
          turn.visibleWhenCollapsed.push(item)
        }
      } else {
        turn.tail.push(item)
      }
    }

    // A turn opens on a user message or a divider; both carry their own clock.
    const lead = turn.lead
    turn.startedAt =
      lead && (lead.kind === 'user' || lead.kind === 'system')
        ? lead.message.timestamp
        : firstTimestamp(body)
  }

  return turns
}

function firstTimestamp(items: GroupedItem[]): number {
  for (const item of items) {
    if (item.kind === 'tool-group' || item.kind === 'subagent-group' || item.kind === 'relay-group') return item.messages[0].timestamp
    if (item.kind !== 'live-assistant') return item.message.timestamp
  }
  return 0
}

/**
 * §16 — one row reports the run, and never two. Two things already report it on
 * their own: a tool group at the tail of the turn, whose row carries the spinner
 * even between calls, and streaming text, which *is* the evidence that something
 * is happening. So the live row is for the case neither covers — nothing on
 * screen yet, nothing moving — which is the only time "Thinking" tells the
 * reader anything they can't already see.
 */
export function needsLiveRow(turn: Turn): boolean {
  const last = turn.body[turn.body.length - 1]
  // A relay stack at the tail carries its own live chrome (pulse dot, "writing
  // a reply" shimmer) — a Thinking row under it would report the run twice.
  return last?.kind !== 'tool-group' && last?.kind !== 'live-assistant' && last?.kind !== 'relay-group'
}

/** Wall time the turn covers — the only figure the collapsed label prints. */
export function turnDurationMs(turn: Turn): number | null {
  if (!turn.startedAt) return null
  let end = turn.end?.timestamp ?? -Infinity
  for (const tool of turn.tools) {
    if (tool.toolCompletedAt) end = Math.max(end, tool.toolCompletedAt)
    end = Math.max(end, tool.timestamp)
  }
  for (const item of [...turn.body, ...turn.tail]) {
    if (item.kind === 'live-assistant') continue
    if (item.kind === 'tool-group' || item.kind === 'subagent-group' || item.kind === 'relay-group') continue
    end = Math.max(end, item.message.timestamp)
  }
  if (!Number.isFinite(end) || end <= turn.startedAt) return null
  return end - turn.startedAt
}
