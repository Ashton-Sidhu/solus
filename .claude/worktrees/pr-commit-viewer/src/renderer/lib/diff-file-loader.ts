import type {
  FileDiffLoadedFiles,
  FileDiffMetadata,
} from '@pierre/diffs'
import type { SolusAPI } from '../../preload'
import type { DiffScope, IpcContext } from '../../shared/types'

type DiffFileApi = Pick<SolusAPI, 'diffFileContents'>

/**
 * Adapt Solus's scope-aware blob loader to @pierre/diffs' lazy hydration
 * contract. Pure renames intentionally omit the old side as required by the
 * library; changed and rename-changed files require both exact patch endpoints.
 */
export async function loadDiffFiles(
  api: DiffFileApi,
  ctx: IpcContext,
  scope: DiffScope,
  fileDiff: FileDiffMetadata,
  livePaths?: string[],
): Promise<FileDiffLoadedFiles> {
  const result = await api.diffFileContents(ctx, {
    scope: { ...scope },
    path: fileDiff.name,
    previousPath: fileDiff.prevName,
    livePaths,
    expectedOldObjectId: fileDiff.prevObjectId,
    expectedNewObjectId: fileDiff.newObjectId,
  })
  if (!result?.newFile) {
    throw new Error(`Full contents are unavailable for ${fileDiff.name}`)
  }
  if (fileDiff.type === 'rename-pure') {
    return { oldFile: null, newFile: result.newFile }
  }
  if (!result.oldFile) {
    throw new Error(`Previous contents are unavailable for ${fileDiff.name}`)
  }
  return { oldFile: result.oldFile, newFile: result.newFile }
}
