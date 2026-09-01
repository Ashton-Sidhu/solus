export type FileChangePreview = {
  path: string
  kind: string
  diff: string
}

function formatChangeKind(kind: unknown): string {
  if (!kind || typeof kind !== 'object' || !('type' in kind)) return 'update'
  const type = String(kind.type)
  if (type !== 'update') return type
  const movePath = 'move_path' in kind && typeof kind.move_path === 'string' ? kind.move_path : null
  return movePath ? `move to ${movePath}` : 'update'
}

export function fileChangePreviews(input?: Record<string, unknown> | null): FileChangePreview[] {
  const changes = input?.changes
  if (!Array.isArray(changes)) return []

  return changes
    .map((change): FileChangePreview | null => {
      if (!change || typeof change !== 'object') return null
      const path = 'path' in change && typeof change.path === 'string' ? change.path : 'file'
      const diff = 'diff' in change && typeof change.diff === 'string' ? change.diff : ''
      if (!diff) return null
      return {
        path,
        kind: formatChangeKind('kind' in change ? change.kind : null),
        diff,
      }
    })
    .filter((change): change is FileChangePreview => change !== null)
}
