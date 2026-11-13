import { parsePatchFileList } from '../../../lib/pierre-diff'
import { diffFileStats } from '../../../lib/diffTreeAdapter'
import { splitPatchByFile } from '../../pr-review/guide/lib/guide-data'

/** One file of a version's source change, with its own part of the patch. */
export interface VersionDiffFile {
  path: string
  additions: number
  deletions: number
  /** Empty for a binary file, or a rename with no change. */
  patch: string
}

/** The files a version's unified patch changes, in the patch's order. */
export function versionDiffFiles(patch: string): VersionDiffFile[] {
  if (!patch) return []
  const patchByPath = splitPatchByFile(patch)
  return parsePatchFileList(patch).map((file) => ({ path: file.name, ...diffFileStats(file), patch: patchByPath.get(file.name) ?? '' }))
}
