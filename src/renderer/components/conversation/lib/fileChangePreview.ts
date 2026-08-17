import type { PermissionToolInput } from '../../../../shared/types'
import { z } from 'zod'

export type FileChangePreview = {
  path: string
  kind: string
  diff: string
}

const changeKindSchema = z.object({
  type: z.string(),
  move_path: z.string().optional(),
})

const fileChangeSchema = z.object({
  path: z.string().optional(),
  diff: z.string(),
  kind: changeKindSchema.optional(),
})

type ChangeKind = z.infer<typeof changeKindSchema>

function formatChangeKind(kind?: ChangeKind): string {
  if (!kind) return 'update'
  const type = kind.type
  if (type !== 'update') return type
  return kind.move_path ? `move to ${kind.move_path}` : 'update'
}

export function fileChangePreviews(input?: PermissionToolInput | null): FileChangePreview[] {
  const changes = input?.changes
  if (!Array.isArray(changes)) return []

  return changes.flatMap((change): FileChangePreview[] => {
      const parsed = fileChangeSchema.safeParse(change)
      if (!parsed.success || !parsed.data.diff) return []
      return [{
        path: parsed.data.path ?? 'file',
        kind: formatChangeKind(parsed.data.kind),
        diff: parsed.data.diff,
      }]
    })
}
