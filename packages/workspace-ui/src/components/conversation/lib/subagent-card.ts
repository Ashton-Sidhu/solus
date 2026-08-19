import type { Message } from '@solus/contracts/types'
import type { SubagentRowState, SubagentSteps } from './subagent-group'
import { leadParagraph, reportSections, reportText, subagentFilePaths } from './subagent-view'

/**
 * §3 — the subagent's two faces in the thread. While it runs it is a row on a
 * chassis: a task, the step in flight, and a hairline seam across the bottom edge
 * that is the step meter. When it lands the chassis becomes a card, because now
 * there is something to read — the report's own first paragraph, a compact
 * outline of its findings, the files it changed, and a receipt.
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

export interface StepsFigure {
  /** Position, at full weight. */
  done: string
  /** `/7`, at half weight. Empty when the agent wrote no plan to count against. */
  total: string
}

/** `3/7` as two weights: the numerator is the position a reader acts on, the
 *  denominator is context. Set as one figure they read it as a ratio to compute. */
export function stepsFigure(steps: SubagentSteps): StepsFigure {
  return {
    done: String(Math.max(steps.done, 0)),
    total: steps.total > 0 ? `/${steps.total}` : '',
  }
}

export interface TargetPath {
  /** Directory prefix including its trailing slash, shown at reduced weight.
   *  Empty when the target isn't a path. */
  dir: string
  /** The filename — or the whole target, when it isn't a path. */
  file: string
}

/** Three segments places a file. The worktree prefix above it is identical for
 *  every row in the session, and the finished card states it once at the bottom. */
const PATH_SEGMENTS = 3

/**
 * The live target, split so the filename can carry full weight and the directory
 * sit back — legible trimmed, without a tooltip. A Grep pattern or a Bash command
 * is left whole: slicing it into directories would invent a structure it doesn't
 * have.
 */
export function subagentTargetPath(target: string): TargetPath {
  const trimmed = target.trim()
  if (!trimmed.includes('/') || /\s/.test(trimmed)) return { dir: '', file: trimmed }

  const segments = trimmed.split('/').filter(Boolean).slice(-PATH_SEGMENTS)
  const file = segments.pop() ?? ''
  return { dir: segments.length > 0 ? `${segments.join('/')}/` : '', file }
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

/** Past this the return card becomes a second report instead of a glance. */
const REPORT_HIGHLIGHTS = 3

export interface SubagentReportHighlight {
  heading: string
  /** The section's own opening finding. Empty when it opens with structured content. */
  finding: string
}

export interface SubagentReportPreview {
  highlights: SubagentReportHighlight[]
  more: number
}

/**
 * A compact index into a structured report. Both the headings and findings are
 * lifted from the subagent's markdown; the return card does not synthesize a
 * summary or infer which findings matter most.
 */
export function subagentReportPreview(message: Message): SubagentReportPreview {
  const outline = reportSections(reportText(message))
  if (!outline) return { highlights: [], more: 0 }

  return {
    highlights: outline.sections.slice(0, REPORT_HIGHLIGHTS).map((section) => ({
      heading: section.heading,
      finding: section.verdict,
    })),
    more: Math.max(outline.sections.length - REPORT_HIGHLIGHTS, 0),
  }
}
