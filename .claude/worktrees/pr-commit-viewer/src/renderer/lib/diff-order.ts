import type { FileDiffMetadata } from '@pierre/diffs'
import { prepareFileTreeInput } from '@pierre/trees'
import { toTreeDisplayPath } from './diffTreeAdapter'

/** Match the file tree's folder-first, depth-first natural path order. */
export function orderDiffFiles(files: FileDiffMetadata[]): FileDiffMetadata[] {
  const fileByDisplayPath = new Map(
    files.map((file) => [toTreeDisplayPath(file.name), file]),
  )
  const prepared = prepareFileTreeInput([...fileByDisplayPath.keys()], {
    flattenEmptyDirectories: true,
  })
  return prepared.paths.map((path) => fileByDisplayPath.get(path)!)
}
