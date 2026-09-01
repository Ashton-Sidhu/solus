import type { FileDiffMetadata } from '@pierre/diffs'
import type { TurnSnapshot } from '@solus/contracts/types'
import { diffFilePath, diffFileStats, toTreeDisplayPath } from '../../../lib/diffTreeAdapter'

/**
 * What the header can say and do about the guide.
 *
 * Staleness used to be a chip inside the guide's own intro, which meant the one
 * fact that decides whether the narrative is worth reading was buried in the
 * narrative. It belongs with the rest of this change's state: on the band.
 */
export interface GuideHeaderActions {
  /** A guide exists to regenerate. Absent guides are offered in the body. */
  present: boolean
  /** Commits landed after the guide was written. */
  stale: boolean
  /** A regeneration is already in flight. */
  regenerating: boolean
  onRegenerate: (mode: 'full' | 'new-commits') => void
}

/** One row of the review panel's change-summary popover. */
export interface ChangedFileSummary {
  /** The diff's own path, handed straight back to the jump action. */
  path: string
  /** Everything up to and including the last separator. Truncates. */
  dir: string
  /** The filename. Never truncates — it is what identifies the row. */
  name: string
  /** Repo-relative path, for the native title. */
  displayPath: string
  additions: number
  deletions: number
}

export function toChangedFileSummaries(files: FileDiffMetadata[]): ChangedFileSummary[] {
  return files.map((file) => {
    const path = diffFilePath(file)
    const displayPath = toTreeDisplayPath(path)
    const cut = displayPath.lastIndexOf('/')
    const stats = diffFileStats(file)
    return {
      path,
      dir: cut === -1 ? '' : displayPath.slice(0, cut + 1),
      name: cut === -1 ? displayPath : displayPath.slice(cut + 1),
      displayPath,
      additions: stats.additions,
      deletions: stats.deletions,
    }
  })
}

/**
 * The turn scrubber's fixed-width label.
 *
 * Two forms rather than one so the column can be sized once and never move as
 * the turn steps: the wide band spells the noun, the narrow one keeps only the
 * position. `All` is the session's whole change — the scrubber cycles through
 * it rather than stopping at either end, which is what ⌥←/⌥→ have always done.
 */
export function turnScrubberLabel(
  turns: TurnSnapshot[],
  selectedTurnIndex: number | null,
  form: 'wide' | 'narrow',
): string {
  if (selectedTurnIndex === null) return 'All'
  const position = turns.findIndex((turn) => turn.index === selectedTurnIndex) + 1
  if (position === 0) return 'All'
  const counter = `${position}/${turns.length}`
  return form === 'wide' ? `Turn ${counter}` : counter
}
