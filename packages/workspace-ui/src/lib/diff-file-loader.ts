import type {
  FileDiffLoadedFiles,
  FileDiffMetadata,
} from '@pierre/diffs'
import type { SolusAPI } from '@solus/contracts/host-api'
import type { DiffFileContentsRequest, DiffScope, IpcContext } from '@solus/contracts/types'

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
  /** The session folder whose repository holds the file. Absent is the working directory. */
  repositoryPath?: string,
): Promise<FileDiffLoadedFiles> {
  const request: DiffFileContentsRequest = {
    scope: { ...scope },
    path: fileDiff.name,
    previousPath: fileDiff.prevName,
    expectedOldObjectId: fileDiff.prevObjectId,
    expectedNewObjectId: fileDiff.newObjectId,
  }
  if (repositoryPath) request.repositoryPath = repositoryPath
  const result = await api.diffFileContents(ctx, request)
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
