import { parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs'
import type { WorkType } from '@solus/contracts/types'

export interface WorkSourceDiff {
  file: FileDiffMetadata | null
  additions: number
  deletions: number
  error: string | null
}

/** Parse once for the counts, moved-line analysis, and source renderer. Compare
 * bodies, not archive heads: the current draft can be ahead of its Git commit. */
export function workSourceDiff(type: WorkType, before: string, after: string): WorkSourceDiff {
  if (before === after) return { file: null, additions: 0, deletions: 0, error: null }
  const extension = type === 'artifact' ? 'html' : 'md'
  const name = `content.${extension}`
  try {
    const file = parseDiffFromFile({ name, contents: before }, { name, contents: after })
    let additions = 0
    let deletions = 0
    for (const hunk of file.hunks) {
      additions += hunk.additionLines
      deletions += hunk.deletionLines
    }
    return { file, additions, deletions, error: null }
  } catch (error) {
    return { file: null, additions: 0, deletions: 0, error: error instanceof Error ? error.message : String(error) }
  }
}
