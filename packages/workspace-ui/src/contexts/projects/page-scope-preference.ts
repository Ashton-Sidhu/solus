import { z } from 'zod'
import type { ProjectPageScope } from './project-catalog'

/**
 * The project pages' scope, kept on this device across a reload
 * (docs/plans/project-model.md §5): the first visit shows All projects, and
 * after that the pages open on the scope the person last chose.
 */

const STORAGE_KEY = 'solus.projectPageScope'

const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({
    kind: z.literal('project'),
    key: z.string().min(1),
    checkout: z.object({ serverId: z.string().min(1), projectRoot: z.string().min(1) }).nullable(),
  }),
])

export function loadProjectPageScope(): ProjectPageScope {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    const parsed = raw ? scopeSchema.safeParse(JSON.parse(raw)) : null
    return parsed?.success ? parsed.data : { kind: 'all' }
  } catch {
    return { kind: 'all' }
  }
}

export function saveProjectPageScope(scope: ProjectPageScope): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(scope))
  } catch {}
}
