import { isQuestionTool } from '@solus/contracts/question-history'
import type { User } from '@solus/contracts/user'
import type { Activity } from '@solus/contracts/activity'
import type { Message, SessionStatus } from '@solus/contracts/types'
import { isAgentNotice, isNoReplyNotice } from '../../../contexts/workspace/session.utils'
import { dividesThread } from '../../activity/lib/activity-line'

export type GroupedItem =
  | { kind: 'question'; message: Message }
  | { kind: 'user'; message: Message }
  | { kind: 'assistant'; message: Message }
  /** Thoughts between two prose blocks with no tool call beside them. Once a
   *  tool call is beside them, they fold into its tool group instead. */
  | { kind: 'thought'; message: Message }
  | { kind: 'system'; message: Message }
  /** Everything the agent did between two prose blocks, as one row. `messages`
   *  are the tool calls; `steps` are the same calls plus the messages that only
   *  carry thoughts into the row, in the order they happened. */
  | { kind: 'tool-group'; messages: Message[]; steps: Message[] }
  | { kind: 'subagent-group'; messages: Message[] }
  | { kind: 'plan'; message: Message }
  | { kind: 'document'; messages: Message[] }
  | { kind: 'automation'; message: Message }
  | { kind: 'watch'; message: Message }
  | { kind: 'task'; message: Message }
  | { kind: 'browser-snapshot'; messages: Message[] }
  | { kind: 'browser-recording'; message: Message }
  | { kind: 'agent-conversation-group'; messages: Message[] }
  | { kind: 'artifact'; message: Message }
  | { kind: 'review-guide'; message: Message }

/** The card kinds that gather a whole turn's members into one card. */
type CardGroupKind = 'subagent-group' | 'agent-conversation-group' | 'browser-snapshot' | 'document'

export function groupMessages(messages: Message[]): GroupedItem[] {
  const result: GroupedItem[] = []
  // A turn's cards of one kind are one act — delegating to sub-agents, talking
  // to other sessions, looking at pages, writing documents — so each kind is one
  // card at the position of its FIRST member, in the order they happened. Tool
  // rows, prose, and other cards between two members still render in place,
  // below the card, and do NOT close it — only a new turn does. An open card's
  // array is grown in place.
  const cardGroups = new Map<CardGroupKind, Message[]>()
  const openOrGrowCard = (kind: CardGroupKind, msg: Message) => {
    const group = cardGroups.get(kind)
    if (group) {
      const existing = kind === 'document'
        ? group.findIndex((message) => message.workRef?.workId === msg.workRef?.workId)
        : -1
      if (existing >= 0) group[existing] = msg
      else group.push(msg)
    } else {
      const messages = [msg]
      cardGroups.set(kind, messages)
      result.push({ kind, messages })
    }
  }
  // Everything between two prose blocks is one activity row: the tool calls,
  // and the thoughts of the messages around them. Only prose, a card, or a
  // notice closes the row.
  let activity: Message[] = []
  const flushActivity = () => {
    if (activity.length === 0) return
    const tools = activity.filter((message) => message.role === 'tool')
    if (tools.length > 0) result.push({ kind: 'tool-group', messages: tools, steps: activity })
    else for (const message of activity) result.push({ kind: 'thought', message })
    activity = []
  }
  for (const msg of messages) {
    if (msg.questionAnswer || (msg.role === 'tool' && isQuestionTool(msg.toolName) && msg.toolStatus !== 'running')) {
      flushActivity()
      result.push({ kind: 'question', message: msg })
    } else if (msg.role === 'tool' && msg.subMessages) {
      flushActivity()
      openOrGrowCard('subagent-group', msg)
    } else if (msg.role === 'tool') {
      activity.push(msg)
    } else if (msg.agentConversationRef) {
      flushActivity()
      openOrGrowCard('agent-conversation-group', msg)
    } else {
      // The thoughts before a message belong to the row above it, not to the
      // message: they are how the agent got there.
      if (msg.thoughts?.length) activity.push(msg)
      // A blank assistant message shows nothing, so it does not close the row.
      if (activity.length > 0 && isBlankAssistant(msg)) continue
      flushActivity()
      if (opensTurn(msg)) cardGroups.clear()
      if (msg.browserSnapshot) {
        openOrGrowCard('browser-snapshot', msg)
        continue
      }
      // A rendered artifact carries its work reference for the frame's own
      // rail; it is shown flush, never folded into a document stack.
      if (msg.workRef && !msg.artifact) {
        openOrGrowCard('document', msg)
        continue
      }
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
      else if (msg.watchRef) result.push({ kind: 'watch', message: msg })
      else if (msg.taskRef) result.push({ kind: 'task', message: msg })
      else if (msg.browserRecording) result.push({ kind: 'browser-recording', message: msg })
      else if (msg.artifact) result.push({ kind: 'artifact', message: msg })
      else if (msg.reviewGuideRef) result.push({ kind: 'review-guide', message: msg })
      else if (msg.role === 'assistant') result.push({ kind: 'assistant', message: msg })
      else if (msg.role === 'plan') result.push({ kind: 'plan', message: msg })
      else result.push({ kind: 'system', message: msg })
    }
  }
  flushActivity()
  return result
}

/** An assistant message with nothing to render: a placeholder before its
 *  first token, or one that only carried thoughts. */
function isBlankAssistant(msg: Message): boolean {
  if (msg.role !== 'assistant' || msg.content.trim()) return false
  return !(msg.automationRef || msg.watchRef || msg.taskRef || msg.browserRecording || msg.browserSnapshot
    || msg.artifact || msg.workRef || msg.reviewGuideRef)
}

/** The messages `buildTurns` cuts a new turn at: a prompt, or a divider. */
function opensTurn(message: Message): boolean {
  if (message.role === 'user') return !isAgentNotice(message.content)
  return messageDividesThread(message)
}

export function itemKey(item: GroupedItem): string {
  if (item.kind === 'tool-group') return `tg-${item.messages[0].id}`
  if (item.kind === 'subagent-group') return `sg-${item.messages[0].id}`
  if (item.kind === 'agent-conversation-group') return `ag-${item.messages[0].id}`
  if (item.kind === 'browser-snapshot') return `bs-${item.messages[0].id}`
  if (item.kind === 'document') return `ds-${item.messages[0].id}`
  if (item.kind === 'thought') return `th-${item.message.id}`
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
  /** The person who stopped the run: the turn's `stopped` activity. */
  by?: User
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
    // The provider's "by user" names nobody: on a shared session it may not be
    // the reader. The divider names the person only from the turn's `stopped` activity.
    if (/by user/i.test(text)) return { kind: 'stopped', cause: '', detail: '', timestamp: message.timestamp }
    const cause = text.replace(/^request (interrupted|cancelled|canceled)\s*/i, '').trim() || 'cancelled'
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

function isStopActivity(item: GroupedItem): boolean {
  return item.kind === 'system' && item.message.activity?.kind === 'stopped'
}

/** The turn's end with who stopped it. A client that did not stop the run has no provider notice yet; the activity is the ending. */
function endNamingStopper(end: TurnEnd | null, stop: Activity): TurnEnd {
  const named = end ?? { kind: 'stopped', cause: '', detail: '', timestamp: stop.at }
  if (named.kind === 'stopped' && stop.by.kind === 'user') named.by = stop.by.user
  return named
}

function lastStopActivity(body: GroupedItem[]): Activity | undefined {
  for (let index = body.length - 1; index >= 0; index--) {
    const item = body[index]
    if (item.kind === 'system' && item.message.activity?.kind === 'stopped') return item.message.activity
  }
  return undefined
}

/** A fork, agent/model change, or move into a worktree is a statement about the
 *  thread, not something that happened inside a turn — so it opens one rather
 *  than sitting in one, and no fold can ever swallow it. */
function isDivider(item: GroupedItem): boolean {
  return item.kind === 'system' && messageDividesThread(item.message)
}

function messageDividesThread(message: Message): boolean {
  return !!message.activity && dividesThread(message.activity)
}

const OUTPUT_KINDS = new Set<GroupedItem['kind']>(['assistant'])
const COLLAPSE_EXCLUDED_KINDS = new Set<GroupedItem['kind']>([
  'artifact',
  'automation',
  // A watch card is how the person sees and stops the wait it started.
  'watch',
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
  // A recording is the same kind of result, in motion.
  'browser-recording',
  // A plan is what the turn produced, not a step it took to get there — and it
  // is the one card the reader still has to act on after the turn ends.
  'plan',
])

/** A turn can end while its backgrounded sub-agents still run. Their card is
 *  what the session waits on, so it stays on screen until they report; then it
 *  folds with the rest of the work. */
function hasRunningSubagent(item: GroupedItem): boolean {
  return item.kind === 'subagent-group' && item.messages.some((message) => message.toolStatus === 'running')
}

/**
 * Cut the transcript at each user message and task card, then cut each turn once:
 * everything up to its final assistant output is `body`, the rest is `tail`.
 * A finished turn shows the tail and folds the body behind its row — prose, tool
 * calls, sub-agents and intermediate cards. Rendered artifacts, automations,
 * created sessions, and work cards remain visible because they are outcomes of
 * the turn rather than implementation steps. Task cards occupy their own rows.
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
    if (item.kind === 'task') {
      // Task cards are transcript outcomes, not steps in the agent's work.
      // Give each card its own virtual row so the turn disclosure cannot
      // enclose it, even when it arrives between tool calls and an answer.
      open(item, itemKey(item))
      continue
    }
    if (item.kind === 'user' || isDivider(item)) {
      open(item, itemKey(item))
      continue
    }
    if (turns.length === 0 || turns[turns.length - 1].lead?.kind === 'task') {
      open(null, `turn-head-${itemKey(item)}`)
    }
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
    // A person's stop is an activity inside the turn (plans/012 §5). The turn's
    // end names them, so the activity is not a row of its own.
    const stop = lastStopActivity(bodies[i])
    const body = stop ? bodies[i].filter((item) => !isStopActivity(item)) : bodies[i]

    for (const item of body) {
      if (item.kind === 'tool-group' || item.kind === 'subagent-group') {
        turn.tools.push(...item.messages)
      }
      // An answered question folds away with the rest of the work, so the row
      // has to report that the turn asked — otherwise a decision the reader
      // made disappears from the transcript once the turn ends.
      if (item.kind === 'question') turn.tools.push(item.message)
    }

    // Only a notice at the very end closed the run; one in the middle is a
    // transient row the transcript keeps. The row states what stopped the run,
    // so the notice it came from is not also rendered — that would be the same
    // fact told twice.
    const last = body[body.length - 1]
    const endIndex = last?.kind === 'system' && turnEndFor(last.message) ? body.length - 1 : -1
    if (endIndex >= 0 && last.kind === 'system') turn.end = turnEndFor(last.message)
    if (stop) turn.end = endNamingStopper(turn.end, stop)

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
        if (COLLAPSE_EXCLUDED_KINDS.has(item.kind) || hasRunningSubagent(item)) {
          turn.visibleWhenCollapsed.push(item)
        }
      } else {
        turn.tail.push(item)
      }
    }

    // A turn or standalone card lead carries its own clock.
    const lead = turn.lead
    turn.startedAt =
      lead && (lead.kind === 'user' || lead.kind === 'system' || lead.kind === 'task')
        ? lead.message.timestamp
        : firstTimestamp(body)
  }

  return turns
}

/**
 * Where grouping and turn building both start over: a prompt, or a divider
 * that renders as one. No group and no turn crosses it, so a transcript cut at
 * these messages can be grouped and built one segment at a time — and a
 * streamed token re-groups only the segment it lands in.
 *
 * Reads no assistant content: a streamed token must not re-cut the transcript.
 */
export function opensSegment(msg: Message): boolean {
  if (msg.questionAnswer || msg.role === 'tool' || msg.agentConversationRef || msg.thoughts?.length) return false
  if (!opensTurn(msg) || msg.browserSnapshot || (msg.workRef && !msg.artifact)) return false
  if (msg.role === 'user') return true
  if (msg.role === 'assistant') return isNoReplyNotice(msg.content)
  return !(msg.automationRef || msg.watchRef || msg.taskRef || msg.browserRecording || msg.artifact
    || msg.reviewGuideRef || msg.role === 'plan')
}

/**
 * A run marked live through a whole segment is still live in the segment
 * before it only when steered prompts lead every turn in between — the same
 * walk `buildTurns` does, taken one segment at a time.
 */
export function runContinuesBefore(items: GroupedItem[]): boolean {
  if (items[0]?.kind !== 'user') return false
  return items.every((item) => item.kind === 'user'
    ? item.message.delivery === 'steer'
    : item.kind !== 'task' && !isDivider(item))
}

function sameMembers(a: Message[], b: Message[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * groupMessages allocates every item fresh. Hand back the previous item for
 * every row that holds the same messages, and the previous array when no row
 * changed — so a streamed token that only grows text changes nothing
 * downstream of the grouping.
 */
export function reuseGroupedItems(next: GroupedItem[], previous: GroupedItem[]): GroupedItem[] {
  if (previous.length === 0) return next
  const previousByKey = new Map<string, GroupedItem>()
  for (const item of previous) previousByKey.set(itemKey(item), item)
  let unchanged = next.length === previous.length
  for (let i = 0; i < next.length; i++) {
    const fresh = next[i]
    const prior = previousByKey.get(itemKey(fresh))
    if (prior && prior.kind === fresh.kind && ('message' in prior
      ? 'message' in fresh && prior.message === fresh.message
      // A tool group's steps include its calls, and can grow a thought alone.
      : 'steps' in prior ? 'steps' in fresh && sameMembers(prior.steps, fresh.steps)
      : 'messages' in fresh && sameMembers(prior.messages, fresh.messages))) next[i] = prior
    if (next[i] !== previous[i]) unchanged = false
  }
  return unchanged ? previous : next
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
 * The items a reader sees in a turn's body. With tool calls hidden, the rows
 * between two prose blocks go away; questions, sub-agents, and cards stay.
 */
export function visibleTurnBody(turn: Turn, toolCallsShown: boolean): GroupedItem[] {
  return toolCallsShown ? turn.body : turn.body.filter((item) => item.kind !== 'tool-group')
}

/**
 * §16 — one row reports the run, and never two. Two things already report it on
 * their own: a tool group at the tail of the turn, whose row carries the spinner
 * even between calls. So the live row is for the case no tool group covers it.
 * With tool calls hidden, no tool group is on screen to carry the spinner.
 */
export function needsLiveRow(turn: Turn, toolCallsShown = true): boolean {
  // A tool still in flight owns the spinner wherever its group sits. create_work
  // and render_artifact push their card the moment the call starts, so the group
  // stops being the last item while it is still running — checking only the tail
  // would report the same call twice.
  if (toolCallsShown && turn.tools.some((tool) => tool.toolStatus === 'running' && !tool.subMessages)) return false
  const last = toolCallsShown
    ? turn.body[turn.body.length - 1]
    : turn.body.findLast((item) => item.kind !== 'tool-group')
  // A running sub-agent does not: the parent keeps writing below its card, and
  // once the card scrolls away nothing at the tail says the run is still going.
  // Only the card at the tail reports its own agents.
  if (last?.kind === 'subagent-group') {
    return !last.messages.some((message) => message.toolStatus === 'running')
  }
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
