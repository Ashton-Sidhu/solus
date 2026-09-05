import type { Message, SessionStatus } from '@solus/contracts/types'
import { isAgentNotice, isNoReplyNotice } from '../../../contexts/workspace/session.utils'

export type GroupedItem =
  | { kind: 'user'; message: Message }
  | { kind: 'assistant'; message: Message }
  | { kind: 'system'; message: Message }
  | { kind: 'tool-group'; messages: Message[] }
  | { kind: 'subagent-group'; messages: Message[] }
  | { kind: 'plan'; message: Message }
  | { kind: 'document'; messages: Message[] }
  | { kind: 'automation'; message: Message }
  | { kind: 'task'; message: Message }
  | { kind: 'browser-snapshot'; messages: Message[] }
  | { kind: 'agent-conversation-group'; messages: Message[] }
  | { kind: 'artifact'; message: Message }
  | { kind: 'review-guide'; message: Message }

export function groupMessages(messages: Message[]): GroupedItem[] {
  const result: GroupedItem[] = []
  let toolBuf: Message[] = []
  let subagentBuf: Message[] = []
  // The turn's agent-conversation cards stack at the position of the FIRST dispatch, in
  // dispatch order, even though tool rows interleave between them in the raw
  // transcript (each prompt_session is a tool call followed by its agent-conversation
  // message). Tool rows therefore do NOT close the stack — only real prose or
  // a new turn does. The open group's array is grown in place.
  let agentConversationGroup: Message[] | null = null
  // A capture pass is one act of looking, and the transcript has to say so: the
  // frames of a pass stack into one plate at the position of the FIRST capture.
  // Each `browser_snapshot` is a tool call followed by its snapshot message, so
  // tool rows interleave and must NOT close the plate — only prose, another
  // card, or a new turn does. The open plate's array is grown in place.
  let snapshotPlate: Message[] | null = null
  const openOrGrowPlate = (msg: Message) => {
    if (snapshotPlate) snapshotPlate.push(msg)
    else {
      snapshotPlate = [msg]
      result.push({ kind: 'browser-snapshot', messages: snapshotPlate })
    }
  }
  // Documents written back to back are one act of writing, so they are one card:
  // a stack at the position of the FIRST write. Each `create_work` is a tool call
  // followed by its work message, so tool rows interleave and must NOT close the
  // stack — only prose, another card, or a new turn does. The open stack's array
  // is grown in place.
  let documentStack: Message[] | null = null
  const openOrGrowStack = (msg: Message) => {
    if (documentStack) documentStack.push(msg)
    else {
      documentStack = [msg]
      result.push({ kind: 'document', messages: documentStack })
    }
  }
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
    } else if (msg.agentConversationRef) {
      flushTools()
      flushSubagents()
      snapshotPlate = null
      documentStack = null
      if (agentConversationGroup) {
        agentConversationGroup.push(msg)
      } else {
        agentConversationGroup = [msg]
        result.push({ kind: 'agent-conversation-group', messages: agentConversationGroup })
      }
    } else {
      flushTools()
      flushSubagents()
      agentConversationGroup = null
      if (msg.browserSnapshot) {
        documentStack = null
        openOrGrowPlate(msg)
        continue
      }
      // Anything the agent says or produces ends the pass: a second batch of
      // captures after a sentence is a second look, and a second plate.
      snapshotPlate = null
      // A rendered artifact carries its work reference for the frame's own
      // rail; it is shown flush, never folded into a document stack.
      if (msg.workRef && !msg.artifact) {
        openOrGrowStack(msg)
        continue
      }
      documentStack = null
      // The SDK writes its interrupt notice back as a user turn to keep the
      // provider transcript well-formed. Nobody typed it, so it renders as a
      // transient row, not a bubble.
      if (msg.role === 'user' && isAgentNotice(msg.content)) result.push({ kind: 'system', message: msg })
      else if (msg.role === 'user') result.push({ kind: 'user', message: msg })
      // A turn the provider was told not to answer arrives as assistant text.
      // It is the same transient state as an interrupt, so it takes the same row
      // rather than being printed as the turn's answer.
      else if (msg.role === 'assistant' && isNoReplyNotice(msg.content)) result.push({ kind: 'system', message: msg })
      else if (msg.automationRef) result.push({ kind: 'automation', message: msg })
      else if (msg.taskRef) result.push({ kind: 'task', message: msg })
      else if (msg.artifact) result.push({ kind: 'artifact', message: msg })
      else if (msg.reviewGuideRef) result.push({ kind: 'review-guide', message: msg })
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
  if (item.kind === 'agent-conversation-group') return `ag-${item.messages[0].id}`
  if (item.kind === 'browser-snapshot') return `bs-${item.messages[0].id}`
  if (item.kind === 'document') return `ds-${item.messages[0].id}`
  return item.message.id
}

/** Empty provider placeholders occupy transcript history but render nothing.
 * They must not earn a disclosure caret on an otherwise empty turn. */
export function hasVisibleTurnBody(turn: Turn): boolean {
  return turn.body.some((item) => {
    if (item.kind === 'assistant') return !!item.message.content.trim()
    if (item.kind === 'tool-group' || item.kind === 'subagent-group' || item.kind === 'document')
      return item.messages.length > 0
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
/** Both wordings the reducer emits for `session_dead`: a provider that reported
 *  an exit code, and the run watchdog, which has none. */
const DEAD_RE = /^Session (ended unexpectedly|stopped responding)/

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
  const text = item.kind === 'assistant' ? item.message.content : null
  return text !== null && text.trim() === end.detail
}

/** A fork, agent/model change, or move into a worktree is a statement about the
 *  thread, not something that happened inside a turn — so it opens one rather
 *  than sitting in one, and no fold can ever swallow it. */
function isDivider(item: GroupedItem): boolean {
  if (item.kind !== 'system') return false
  const { agentChangedTo, forkSourceSessionId, worktreeMovedTo, newSessionForPlanId } = item.message
  return !!(agentChangedTo || forkSourceSessionId || worktreeMovedTo || newSessionForPlanId)
}

const OUTPUT_KINDS = new Set<GroupedItem['kind']>(['assistant'])
const COLLAPSE_EXCLUDED_KINDS = new Set<GroupedItem['kind']>([
  'artifact',
  'automation',
  'document',
  'agent-conversation-group',
  // The visible /review turn only queues background authoring, then ends with
  // an empty provider message. Its guide reference is the durable outcome and
  // must remain visible while that background run replaces its skeleton with
  // the ready card.
  'review-guide',
  // A screenshot is the visual result of the turn. Folding it would leave the
  // user with only the agent's prose about what the page looked like.
  'browser-snapshot',
  // A plan is what the turn produced, not a step it took to get there — and it
  // is the one card the reader still has to act on after the turn ends.
  'plan',
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

function sameItems<Item>(a: Item[], b: Item[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function sameEnd(a: TurnEnd | null, b: TurnEnd | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.kind === b.kind && a.cause === b.cause && a.detail === b.detail && a.timestamp === b.timestamp
}

/**
 * buildTurns allocates every Turn fresh. Reuse the previous build's Turn object
 * wherever the rebuilt turn is item-for-item identical, so only the turn that
 * changed gets a new identity.
 */
export function stabilizeTurns(next: Turn[], previous: Turn[]): Turn[] {
  if (previous.length === 0) return next
  const previousById = new Map<string, Turn>()
  for (const turn of previous) previousById.set(turn.id, turn)
  for (let i = 0; i < next.length; i++) {
    const fresh = next[i]
    const prior = previousById.get(fresh.id)
    if (
      prior &&
      prior.lead === fresh.lead &&
      prior.live === fresh.live &&
      prior.startedAt === fresh.startedAt &&
      sameEnd(prior.end, fresh.end) &&
      sameItems(prior.body, fresh.body) &&
      sameItems(prior.visibleWhenCollapsed, fresh.visibleWhenCollapsed) &&
      sameItems(prior.tail, fresh.tail) &&
      sameItems(prior.tools, fresh.tools)
    ) {
      next[i] = prior
    }
  }
  return next
}

/** Entry motion belongs to new work at the live edge. A transcript hydration
 * mounts its newest completed turns in one batch; animating those rows makes
 * the assistant output paint before the user bubble and reads as a reorder. */
export function shouldAnimateTurnEntry(turn: Turn, index: number, count: number): boolean {
  return turn.live && index >= Math.max(0, count - 2)
}

function firstTimestamp(items: GroupedItem[]): number {
  for (const item of items) {
    if (
      item.kind === 'tool-group' ||
      item.kind === 'subagent-group' ||
      item.kind === 'agent-conversation-group' ||
      item.kind === 'browser-snapshot' ||
      item.kind === 'document'
    )
      return item.messages[0].timestamp
    return item.message.timestamp
  }
  return 0
}

/**
 * §16 — a turn folds when it *ends*, and a run parked on a question, a
 * permission or a plan has not ended: it is waiting on the reader. Folding there
 * would hide the very output the card asks about — the agent's reasoning sits in
 * `body` (the pending tool call is the last item, so nothing is left in `tail`)
 * and disappears behind a summary row until the card is answered.
 */
export function runIsLive(status: SessionStatus | undefined): boolean {
  return (
    status === 'running' ||
    status === 'connecting' ||
    status === 'awaiting_input' ||
    status === 'awaiting_plan'
  )
}

/**
 * §16 — one row reports the run, and never two. Two things already report it on
 * their own: a tool group at the tail of the turn, whose row carries the spinner
 * even between calls. So the live row is for the case no tool group covers it.
 */
export function needsLiveRow(turn: Turn): boolean {
  // A tool still in flight owns the spinner wherever its group sits. create_work
  // and render_artifact push their card the moment the call starts, so the group
  // stops being the last item while it is still running — checking only the tail
  // would report the same call twice.
  if (turn.tools.some((tool) => tool.toolStatus === 'running')) return false
  const last = turn.body[turn.body.length - 1]
  // An agent-conversation stack at the tail carries its own live chrome (pulse dot, "writing
  // a reply" shimmer) — a Thinking row under it would report the run twice.
  return last?.kind !== 'tool-group' && last?.kind !== 'agent-conversation-group'
}

/** Wall time the turn covers — the only figure the collapsed label prints. */
export function turnDurationMs(turn: Turn): number | null {
  if (!turn.startedAt) return null
  let end = turn.end?.timestamp ?? -Infinity
  for (const tool of turn.tools) {
    if (tool.toolCompletedAt) end = Math.max(end, tool.toolCompletedAt)
    end = Math.max(end, tool.timestamp)
  }
  // Iterate the two slices in place — this runs for every turn on every
  // transcript rebuild, so no merged copy per call.
  for (const items of [turn.body, turn.tail]) {
    for (const item of items) {
      if (item.kind === 'browser-snapshot' || item.kind === 'document') {
        // A plate is several messages but one outcome, and the pass's last
        // frame is as much the end of the turn as a sentence would be.
        for (const member of item.messages) end = Math.max(end, member.timestamp)
        continue
      }
      if (item.kind === 'tool-group' || item.kind === 'subagent-group' || item.kind === 'agent-conversation-group') continue
      end = Math.max(end, item.message.timestamp)
    }
  }
  if (!Number.isFinite(end) || end <= turn.startedAt) return null
  return end - turn.startedAt
}
