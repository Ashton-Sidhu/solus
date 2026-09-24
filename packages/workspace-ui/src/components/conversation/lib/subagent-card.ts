import type { Message } from '@solus/contracts/types'
import { formatActivityDuration } from './activity-summary'
import type { SubagentRow, SubagentRowState, SubagentSteps } from './subagent-group'
import { leadParagraph, reportSections, reportText, subagentFilePaths } from './subagent-view'

/**
 * §3 — the subagent's two faces in the thread. While it runs it is one card
 * line: the task, the step in flight, and a seam across the bottom edge that is
 * the step meter. When it lands the card opens a body, because now there is
 * something to read: the report's own first paragraph and the files it wrote.
 *
 * Everything either face prints is derived here, so the markup stays geometry.
 * The card claims no field the system doesn't have: no line deltas, no open-question
 * tally, and no fraction without a real denominator.
 */

/**
 * One step of the plan, as the seam draws it. Discrete on purpose — a segment is
 * a step, and a step is either behind the agent, under it, or ahead of it. The
 * live one carries the sweep, which is motion without a claim about how much of
 * the step is spent.
 */
export type SeamSegment = 'done' | 'live' | 'failed' | 'pending'

/**
 * The seam. Empty unless the agent kept a plan — without one there is no
 * denominator, and seven pips over a number we invented would read as progress
 * we can't vouch for.
 */
export function seamSegments(steps: SubagentSteps, state: SubagentRowState): SeamSegment[] {
  if (steps.total <= 0) return []

  const done = Math.min(Math.max(steps.done, 0), steps.total)
  return Array.from({ length: steps.total }, (_, i): SeamSegment => {
    if (i < done) return 'done'
    if (i > done) return 'pending'
    // The step at `done` is the one in flight — so it is also the one a failed
    // run died on, rather than the step after it.
    return state === 'running' ? 'live' : state === 'failed' ? 'failed' : 'pending'
  })
}

/**
 * The step figure the rail prints. An agent that kept a plan gives a real
 * denominator (`3/7`); one without has only its tool calls, so the count prints
 * bare. A plan-less agent that has not called a tool yet prints nothing: a bare
 * zero next to a moving clock reads as a hang.
 */
export function stepsRail(steps: SubagentSteps): string {
  if (steps.total > 0) return `${Math.max(steps.done, 0)}/${steps.total}`
  return steps.done > 0 ? String(steps.done) : ''
}

/** The card and row rail: counts and time only, in that order. */
export function subagentRail(row: Pick<SubagentRow, 'steps' | 'elapsedMs'>): string {
  return [stepsRail(row.steps), formatActivityDuration(row.elapsedMs)].filter(Boolean).join(' · ')
}

/** Three segments places a file. The worktree prefix above it is identical for
 *  every row in the session. */
const PATH_SEGMENTS = 3

/**
 * The live target, trimmed to the segments that place the file. A Grep pattern
 * or a Bash command is left whole: slicing it into directories would invent a
 * structure it doesn't have.
 */
export function subagentTargetPath(target: string): string {
  const trimmed = target.trim()
  if (!trimmed.includes('/') || /\s/.test(trimmed)) return trimmed
  return trimmed.split('/').filter(Boolean).slice(-PATH_SEGMENTS).join('/')
}

/**
 * What a running agent is doing, as one truncating line: the step in flight and
 * what it is on, "Reading renderer/panels/HostPicker.svelte". The card's glyph
 * carries the state, so there is no status word. A failed agent says nothing
 * here; its reason goes in the body, where there is room to read it.
 */
export function runCardDetail(row: Pick<SubagentRow, 'state' | 'activity' | 'target'>): string {
  if (row.state === 'failed') return ''
  const activity = row.activity.trim()
  const target = row.target ? subagentTargetPath(row.target) : ''
  return [activity, target].filter(Boolean).join(' ')
}

/** Past this the names stop being evidence and start being a directory listing. */
const FIGURE_NAMES = 3

export interface SubagentFigure {
  /** The count, right-aligned down the card's numeric column. */
  figure: string
  /** The clause it belongs to, muted. */
  label: string
  /** Files named inside the clause, at full weight. */
  names: string[]
  /** Files there wasn't room to name. Zero when they all fit. */
  more: number
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function fileFigure(paths: string[], verb: string, named: boolean): SubagentFigure {
  const names = named ? paths.slice(0, FIGURE_NAMES).map(basename) : []
  return {
    figure: String(paths.length),
    label: `file${paths.length === 1 ? '' : 's'} ${verb}`,
    names,
    more: named ? paths.length - names.length : 0,
  }
}

/**
 * The reviewable output the run actually produced. Writes are named because they
 * are what a reader checks. Reads are deliberately omitted: their count measures
 * effort rather than telling the reader what the agent found.
 */
export function subagentFigures(message: Message): SubagentFigure[] {
  const { wrote } = subagentFilePaths(message.subMessages ?? [])
  return wrote.length > 0 ? [fileFigure(wrote, 'written', true)] : []
}

/** A heading is a label for the answer, not the answer — so the verdict looks past
 *  one to the first thing the agent actually wrote. */
const HEADING_ONLY = /^ {0,3}#{1,6}\s/

/**
 * The sentence the card leads with: the report's first prose paragraph, lifted
 * verbatim — the card never writes a verdict of its own. Headings above it are
 * skipped, because a report that opens on `## Summary` still has a first
 * sentence. Empty when that paragraph is really a list, a fence or a table, or
 * when it runs too long to take at a glance; then the card shows its figures and
 * leaves the prose to the pane.
 */
export function subagentVerdict(message: Message): string {
  const report = reportText(message)
  if (!report) return ''

  const outline = reportSections(report)
  if (outline) return leadParagraph(outline.lead)

  for (const block of report.split(/\n[ \t]*\n/)) {
    const trimmed = block.trim()
    if (!trimmed || HEADING_ONLY.test(trimmed)) continue
    // The first prose block is the verdict or there isn't one. Hunting further
    // would pick a sentence out of the middle of the report.
    return leadParagraph(trimmed)
  }
  return ''
}
