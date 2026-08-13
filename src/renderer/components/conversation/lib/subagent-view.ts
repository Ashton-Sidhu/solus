import type { Message, TodoItem } from '../../../../shared/types'
import { formatTokens } from '../../../lib/contextUsage'
import { formatActivityDuration, parseToolInput, toolPathsFromParsed } from './activity-summary'
import { decodeHtmlEntities } from './html-entities'
import {
  callsOnCurrentStep,
  parseSubagentInput,
  subagentInputText,
  subagentTodos,
} from './subagent'
import {
  subagentLiveStep,
  subagentModelMeta,
  subagentName,
  subagentState,
  type SubagentModelFallback,
  type SubagentRowState,
} from './subagent-group'

/**
 * A subagent is one agent doing one task in a single turn, so its pane holds two
 * views over the same turn: the **report** (its final text — what the reader
 * opened the pane for) and the **transcript** (the run that produced it).
 * Everything either view prints is derived here, so the markup stays geometry.
 */

export interface SubagentHeader {
  title: string
  state: SubagentRowState
  /** Who ran it — "Explore agent, Sonnet 5". */
  identity: string
  /** How the run ended: "finished in" / "running for" / "failed after". */
  verb: string
  duration: string
  /** The checkout it ran in, empty when the session isn't isolated. */
  worktree: string
  /** "read 34 files, wrote none" — empty when it touched no files at all. */
  files: string
}

const VERB_FOR_STATE = {
  running: 'running for',
  done: 'finished in',
  failed: 'failed after',
} as const satisfies Record<SubagentRowState, string>

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * The identity clause. The agent type only earns a mention when it names
 * something — "agent agent" and "general-purpose agent" tell a reader of a
 * subagent pane nothing they don't already know.
 */
function identityOf(message: Message, model: string): string {
  const type = (message.subagentType || parseSubagentInput(message.toolInput).subagent_type || '').trim()
  const named = type && type !== 'agent' && type !== 'general-purpose'
    ? `${type[0].toUpperCase()}${type.slice(1)} agent`
    : ''
  return [named, model].filter(Boolean).join(', ')
}

/**
 * What the run did to the checkout, as one clause. "wrote none" is worth saying
 * out loud — a read-only agent is the common case and the reader wants it
 * confirmed — but only once the agent has read something to report.
 */
function filesClause(counts: { read: number; wrote: number }): string {
  if (counts.read === 0 && counts.wrote === 0) return ''
  return [
    counts.read > 0 ? `read ${plural(counts.read, 'file')}` : '',
    counts.wrote > 0 ? `wrote ${plural(counts.wrote, 'file')}` : 'wrote none',
  ]
    .filter(Boolean)
    .join(', ')
}

export function subagentHeader(
  message: Message,
  fallback: SubagentModelFallback,
  worktree: string,
  now: number,
): SubagentHeader {
  const state = subagentState(message)
  // Turn 4 drops effort from the sentence — the model is the fact a reader acts
  // on, and the pane is quieter for carrying one.
  const [model = ''] = subagentModelMeta(message, fallback)
  const settledAt = message.toolCompletedAt ?? message.timestamp

  return {
    title: subagentName(message),
    state,
    identity: identityOf(message, model),
    verb: VERB_FOR_STATE[state],
    duration: formatActivityDuration(Math.max(0, (state === 'running' ? now : settledAt) - message.timestamp)),
    worktree,
    files: filesClause(subagentFileCounts(message.subMessages ?? [])),
  }
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

/** Distinct files the run read and wrote. An agent that reads one file six times
 *  read one file, so both sides collect paths rather than calls. */
export interface SubagentFilePaths {
  read: string[]
  wrote: string[]
}

export function subagentFilePaths(subs: Message[]): SubagentFilePaths {
  const read = new Set<string>()
  const wrote = new Set<string>()
  for (const m of subs) {
    if (m.role !== 'tool' || m.toolStatus === 'running') continue
    const parsed = m.toolInput ? parseToolInput(m.toolInput) : null
    if (!parsed) continue
    const target = m.toolName === 'Read' ? read : WRITE_TOOLS.has(m.toolName ?? '') ? wrote : null
    if (!target) continue
    for (const path of toolPathsFromParsed(parsed)) target.add(path)
  }
  return { read: [...read], wrote: [...wrote] }
}

export interface SubagentFileCounts {
  read: number
  wrote: number
}

export function subagentFileCounts(subs: Message[]): SubagentFileCounts {
  const { read, wrote } = subagentFilePaths(subs)
  return { read: read.length, wrote: wrote.length }
}

export interface SubagentSegment {
  status: 'done' | 'active' | 'pending' | 'stopped'
  /** Percent of the step in flight already spent. Zero on every other status. */
  fill: number
}

/**
 * §5 — the one progress line under the header. It holds the same slot in every
 * state and survives the run: live it is the position, settled it is the record of
 * what the run cost. The unit is picked once so the line never changes shape
 * mid-flight — the agent's own plan when it kept one, else the asks the dispatch
 * enumerated — and a figure is printed only where a real denominator exists.
 */
export interface SubagentProgress {
  state: SubagentRowState
  /** "Step 3 of 5" · "Working" · "5 of 5 answered" · "Stopped at step 3". */
  label: string
  /** One per plan step or ask. Empty when the run has no real denominator. */
  segments: SubagentSegment[]
  /** The step in flight, in the agent's own words. Empty unless a plan names it. */
  current: string
  /** "1m 46s", "34 read", "0 written" — the same numbers become the run's record. */
  facts: string[]
  /** "2 of 5", for the Report tab. Empty until the run lands with a countable rail. */
  fraction: string
}

/**
 * The step in flight is the one thing on the line without a denominator, so it
 * approaches full without ever arriving: each call closes a fraction of what is
 * left, which reads as motion and never claims the step is done.
 */
function activeFill(calls: number): number {
  return Math.round(Math.min(0.88, 1 - 0.78 ** Math.max(0, calls)) * 100)
}

function planSegments(todos: TodoItem[], state: SubagentRowState, calls: number): SubagentSegment[] {
  return todos.map((todo): SubagentSegment => {
    if (todo.status === 'completed') return { status: 'done', fill: 0 }
    if (todo.status !== 'in_progress') return { status: 'pending', fill: 0 }
    if (state === 'running') return { status: 'active', fill: activeFill(calls) }
    // A run that stopped mid-step keeps the step it stopped on visible; one that
    // finished with a step still open never closed it, so it stays unfilled.
    return { status: state === 'failed' ? 'stopped' : 'pending', fill: 0 }
  })
}

/** Elapsed and the file tally: what the run cost, which is knowable whether or not
 *  its shape ever was. The clock stops at the settle, so a finished line stops
 *  counting up. */
function runFacts(message: Message, state: SubagentRowState, now: number): string[] {
  const settledAt = message.toolCompletedAt ?? message.timestamp
  const counts = subagentFileCounts(message.subMessages ?? [])
  return [
    formatActivityDuration(Math.max(0, (state === 'running' ? now : settledAt) - message.timestamp)),
    counts.read > 0 ? `${counts.read} read` : '',
    // "0 written" is the fact a reader of a read-only agent wants confirmed, but
    // only once it has read something to report.
    counts.wrote > 0 ? `${counts.wrote} written` : counts.read > 0 ? '0 written' : '',
  ].filter(Boolean)
}

function askLabel(state: SubagentRowState, fraction: string): string {
  // The brief says how much work there is, never how much of it is done — so a
  // live run with no plan of its own states no position at all.
  if (state === 'running') return 'Working'
  if (!fraction) return state === 'failed' ? 'Stopped' : 'Finished'
  return state === 'failed' ? `Stopped · ${fraction} answered` : `${fraction} answered`
}

export function subagentProgress(message: Message, now: number): SubagentProgress {
  const state = subagentState(message)
  const facts = runFacts(message, state, now)
  const todos = subagentTodos(message)

  if (todos.length > 0) {
    const done = todos.filter((todo) => todo.status === 'completed').length
    const open = todos.findIndex((todo) => todo.status === 'in_progress')
    const position = open >= 0 ? open + 1 : Math.min(done + 1, todos.length)
    return {
      state,
      label:
        state === 'running'
          ? `Step ${position} of ${todos.length}`
          : state === 'failed'
            ? `Stopped at step ${position}`
            : `${done} of ${todos.length} done`,
      segments: planSegments(todos, state, callsOnCurrentStep(message)),
      current: state === 'running' && open >= 0 ? todos[open].content : '',
      facts,
      fraction: '',
    }
  }

  const asks = briefAsks(subagentInputText(parseSubagentInput(message.toolInput)))
  // One section per ask is the only per-ask evidence the pane ever gets, and it
  // exists only once the agent has written its report.
  const sections = reportSections(reportText(message))?.sections.length ?? 0
  // More sections than asks still reads as answered — the agent gave extra, not
  // less, which is the rule the brief's own count already follows.
  const answered = Math.min(sections, asks.length)
  const fraction = answered > 0 ? `${answered} of ${asks.length}` : ''

  return {
    state,
    label: askLabel(state, fraction),
    segments: asks.map((_, i): SubagentSegment => ({
      status: i < answered ? 'done' : 'pending',
      fill: 0,
    })),
    current: '',
    facts,
    fraction,
  }
}

export interface SubagentFooter {
  /** The participle for the call in flight — the only moving text in the pane. */
  activity: string
  /** What that call names. Mono, truncates. */
  target: string
  /** "14 tool calls", "24.1K ctx" — how big the run has got. */
  facts: string[]
}

/**
 * §5a's footer: what the agent is doing this second, which is a different
 * question from how far through the brief it is. The Report tab carries it because
 * the Transcript tab is already the live stream.
 */
export function subagentFooter(message: Message): SubagentFooter {
  const subs = message.subMessages ?? []
  const calls = Math.max(
    subs.reduce((n, m) => (m.role === 'tool' ? n + 1 : n), 0),
    message.backgroundTaskProgress?.toolUses ?? 0,
  )
  const tokens = message.backgroundTaskProgress?.totalTokens ?? 0

  return {
    ...subagentLiveStep(message),
    facts: [
      calls > 0 ? plural(calls, 'tool call') : '',
      tokens > 0 ? `${formatTokens(tokens)} ctx` : '',
    ].filter(Boolean),
  }
}

/**
 * The agent's answer. A blocking agent delivers it as the tool result; a
 * backgrounded one never returns one at all, so its last assistant block in its
 * own transcript *is* the answer.
 */
export function reportText(message: Message): string {
  // Assistant prose emitted while the agent is still working is progress, not
  // its answer. Waiting for the terminal state also keeps the Transcript and
  // Report views consistent with the running status shown in their shared pane.
  if (subagentState(message) === 'running') return ''

  const result = message.report?.trim()
  if (result) return result
  return (message.subMessages ?? [])
    .findLast((m) => m.role === 'assistant' && m.content.trim())
    ?.content.trim() ?? ''
}

export interface ReportSection {
  n: number
  heading: string
  /**
   * The section's opening paragraph, lifted verbatim — the pane never writes a
   * verdict of its own. Empty when the section opens on a block rather than
   * prose, or when the paragraph is too long to read as one.
   */
  verdict: string
  body: string
}

/** Two lines at the report's measure. Past this the wash stops being a verdict
 *  and starts being the paragraph, so it is dropped and the prose just runs. */
const VERDICT_MAX = 190

/** A section that opens on a list, a fence, a quote, a table or a heading is
 *  already structured; washing its first row would pull it out of that. */
const OPENS_ON_BLOCK = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\||\s{4})/

/**
 * A block's opening paragraph, when it reads as a verdict: prose rather than
 * structure, and short enough to take at a glance. Empty otherwise, so a caller
 * shows the block's own shape instead of washing its first row into a sentence.
 */
export function leadParagraph(block: string): string {
  const blank = block.search(/\n[ \t]*\n/)
  const first = (blank === -1 ? block : block.slice(0, blank)).trim()
  if (!first || first.length > VERDICT_MAX || OPENS_ON_BLOCK.test(first)) return ''
  return first
}

interface ReportVerdict {
  verdict: string
  body: string
}

function splitVerdict(body: string): ReportVerdict {
  const verdict = leadParagraph(body)
  if (!verdict) return { verdict: '', body }

  const blank = body.search(/\n[ \t]*\n/)
  return { verdict, body: blank === -1 ? '' : body.slice(blank).trim() }
}

export interface ReportOutline {
  /** Prose above the first heading — the verdict, which the report leads with. */
  lead: string
  sections: ReportSection[]
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*\S)\s*$/
const FENCE = /^ {0,3}(```|~~~)/

/**
 * The numbered rail is derived, not given: it exists only when the agent wrote
 * one ordered heading per ask. Split on the *shallowest* heading level present
 * so a report that leads with `##` numbers its sections rather than its
 * sub-points, and return null below two sections — a rail over a single heading
 * would be inventing a structure the agent didn't write, so the caller renders
 * plain markdown instead.
 */
export function reportSections(markdown: string): ReportOutline | null {
  const lines = markdown.split('\n')
  const headings: Array<{ index: number; depth: number; text: string }> = []
  let fence = ''

  for (const [index, line] of lines.entries()) {
    const opening = FENCE.exec(line)
    if (opening) {
      // A fence only closes on its own marker, so ``` inside a ~~~ block stays content.
      if (!fence) fence = opening[1]
      else if (opening[1] === fence) fence = ''
      continue
    }
    if (fence) continue
    const match = HEADING.exec(line)
    if (match) {
      headings.push({
        index,
        depth: match[1].length,
        text: decodeHtmlEntities(match[2]),
      })
    }
  }

  if (headings.length < 2) return null
  const depth = Math.min(...headings.map((heading) => heading.depth))
  const tops = headings.filter((heading) => heading.depth === depth)
  if (tops.length < 2) return null

  return {
    lead: lines.slice(0, tops[0].index).join('\n').trim(),
    sections: tops.map((heading, i) => ({
      n: i + 1,
      heading: heading.text,
      ...splitVerdict(lines.slice(heading.index + 1, tops[i + 1]?.index ?? lines.length).join('\n').trim()),
    })),
  }
}

/**
 * What the collapsed brief says about itself: how many asks the dispatch made,
 * and how many the report came back with. Counts only — the card never claims a
 * per-ask match it hasn't checked.
 */
export function briefMeta(asks: string[], sections: number): string[] {
  if (asks.length === 0) return []
  return [
    plural(asks.length, 'ask'),
    sections === 0
      ? ''
      : sections >= asks.length
        ? 'all answered'
        : `${sections} of ${asks.length} answered`,
  ].filter(Boolean)
}

/** The one fact about the run worth restating beside the brief: whether it
 *  touched the checkout at all. */
export function writesClause(message: Message): string {
  const { wrote } = subagentFileCounts(message.subMessages ?? [])
  return wrote === 0 ? 'No writes' : `${plural(wrote, 'file')} written`
}

const ASK = /^\s*\d+[.)]\s+(.*\S)\s*$/

/** The numbered asks the dispatch prompt spelled out, so the brief can say how
 *  many there were and the transcript can list them. */
export function briefAsks(prompt: string): string[] {
  return prompt
    .split('\n')
    .map((line) => ASK.exec(line)?.[1])
    .filter((ask): ask is string => !!ask)
}

export type TimelineEntry =
  | { kind: 'dispatch'; offsetMs: number; prompt: string; asks: string[]; call: string }
  | { kind: 'text'; offsetMs: number; id: string; content: string; isReport: boolean }
  | { kind: 'tools'; offsetMs: number; id: string; tools: Message[] }

/** The call that started the run, named as itself — "Task · subagent_type: explore". */
function dispatchCall(message: Message): string {
  const type = (message.subagentType || parseSubagentInput(message.toolInput).subagent_type || '').trim()
  return [message.toolName || 'Task', type ? `subagent_type: ${type}` : ''].filter(Boolean).join(' · ')
}

/**
 * The turn as it happened, offsets relative to dispatch. Consecutive tool calls
 * share one entry so the gutter prints a time per *step* the reader can follow,
 * not per call — and so the entry can hand the whole run of them to the same
 * grouped activity row the main thread uses.
 */
export function subagentTimeline(message: Message): TimelineEntry[] {
  const start = message.timestamp
  const prompt = subagentInputText(parseSubagentInput(message.toolInput))
  const entries: TimelineEntry[] = [
    { kind: 'dispatch', offsetMs: 0, prompt, asks: briefAsks(prompt), call: dispatchCall(message) },
  ]

  let tools: Message[] = []
  const flush = () => {
    if (tools.length === 0) return
    entries.push({
      kind: 'tools',
      offsetMs: tools[0].timestamp - start,
      id: tools[0].id,
      tools,
    })
    tools = []
  }

  for (const m of message.subMessages ?? []) {
    if (m.role === 'tool') {
      tools.push(m)
    } else if (m.role === 'assistant' && m.content.trim()) {
      flush()
      entries.push({
        kind: 'text',
        offsetMs: m.timestamp - start,
        id: m.id,
        content: m.content.trim(),
        isReport: false,
      })
    }
  }
  flush()

  // Report is a filter over this stream, not a second message: the block the
  // Report tab shows is one of these entries, so mark it rather than reprinting
  // its markdown here. Compared by content because a blocking agent's answer
  // arrives as the tool result and a backgrounded one's never does.
  const report = reportText(message)
  const last = entries.findLast((entry) => entry.kind === 'text')
  if (report && last?.kind === 'text' && last.content === report) last.isReport = true

  return entries
}

export interface SubagentTail {
  /** How the run ended, stated flatly. */
  label: string
  /** Size of the run — calls and files, both counted from the calls themselves. */
  facts: string
}

/** The transcript's closing row: how the run ended, and how much of it there was. */
export function subagentTail(message: Message): SubagentTail {
  const state = subagentState(message)
  const subs = message.subMessages ?? []
  const calls = subs.reduce((n, m) => (m.role === 'tool' ? n + 1 : n), 0)
  const counts = subagentFileCounts(subs)

  return {
    label: state === 'running' ? 'Still running' : state === 'failed' ? 'Turn failed' : 'Turn ended',
    facts: [
      calls > 0 ? plural(calls, 'tool call') : '',
      counts.read > 0 ? `${plural(counts.read, 'file')} read` : '',
      counts.wrote > 0 ? `${plural(counts.wrote, 'file')} written` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  }
}

/** `mm:ss` since dispatch, for the transcript's left margin. */
export function formatOffset(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}
