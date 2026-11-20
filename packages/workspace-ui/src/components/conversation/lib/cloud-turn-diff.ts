import { parsePatchFileList } from '../../../lib/pierre-diff'
import { diffFileStats } from '../../../lib/diffTreeAdapter'
import { splitPatchByFile } from '../../pr-review/guide/lib/guide-data'

/** One file of a turn's patch from the cloud copy, as its card draws it. */
export interface CloudTurnDiffFile {
  path: string
  additions: number
  deletions: number
  /** The file's own part of the patch; empty for a binary file or a pure rename. */
  patch: string
}

/** The files of a turn's patch, in patch order. */
export function cloudTurnDiffFiles(patch: string): CloudTurnDiffFile[] {
  const byPath = splitPatchByFile(patch)
  return parsePatchFileList(patch).map((file) => ({ path: file.name, ...diffFileStats(file), patch: byPath.get(file.name) ?? '' }))
}
