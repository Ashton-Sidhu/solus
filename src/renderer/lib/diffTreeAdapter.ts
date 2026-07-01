import type { GitStatusEntry, GitStatus, FileTreeRowDecorationRenderer } from '@pierre/trees'
import type { FileDiffMetadata } from '@pierre/diffs'
import type { DiffComment } from '../../shared/types'

type DiffFileStatus = 'A' | 'M' | 'D' | 'R'

const STATUS_MAP: Record<DiffFileStatus, GitStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
}

export function diffFilePath(file: FileDiffMetadata): string {
  return file.name
}

export function diffFileStatus(file: FileDiffMetadata): DiffFileStatus {
  if (file.type === 'new') return 'A'
  if (file.type === 'deleted') return 'D'
  if (file.type === 'rename-pure' || file.type === 'rename-changed') return 'R'
  return 'M'
}

export function diffFileStats(file: FileDiffMetadata): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const hunk of file.hunks) {
    additions += hunk.additionLines
    deletions += hunk.deletionLines
  }
  return { additions, deletions }
}

export function diffHeaderStats(files: FileDiffMetadata[]): { files: number; additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const file of files) {
    const stats = diffFileStats(file)
    additions += stats.additions
    deletions += stats.deletions
  }
  return { files: files.length, additions, deletions }
}

/**
 * Drops a leading `/` so absolute paths don't render an empty first segment,
 * which would prefix the row with a phantom " / ".
 */
export function toTreeDisplayPath(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path
}

export function toGitStatusEntries(files: FileDiffMetadata[]): GitStatusEntry[] {
  return files.map((f) => ({
    path: toTreeDisplayPath(diffFilePath(f)),
    status: STATUS_MAP[diffFileStatus(f)],
  }))
}

export function createRowDecorationRenderer(
  files: FileDiffMetadata[],
  comments: DiffComment[],
): FileTreeRowDecorationRenderer {
  const fileByDisplay = new Map<string, FileDiffMetadata>()
  for (const f of files) fileByDisplay.set(toTreeDisplayPath(diffFilePath(f)), f)
  const commentCountByDisplay = new Map<string, number>()
  for (const c of comments) {
    const key = toTreeDisplayPath(c.filePath)
    commentCountByDisplay.set(key, (commentCountByDisplay.get(key) ?? 0) + 1)
  }

  return (context) => {
    const file = fileByDisplay.get(context.item.path)
    if (!file) return null
    const cc = commentCountByDisplay.get(context.item.path) ?? 0
    const stats = diffFileStats(file)

    // ◉ tints with currentColor; the numeric counts remain plain so the row's
    // theme tokens (selected / hover / muted) carry through cleanly.
    const parts: string[] = []
    if (cc > 0) parts.push(`◉ ${cc}`)
    if (stats.additions > 0) parts.push(`+${stats.additions}`)
    if (stats.deletions > 0) parts.push(`−${stats.deletions}`)

    return {
      text: parts.join('  '),
      title: `${stats.additions} additions, ${stats.deletions} deletions${cc > 0 ? `, ${cc} comment${cc > 1 ? 's' : ''}` : ''}`,
    }
  }
}
