import { z } from 'zod'

/** The sorts T3 Code offers: time only. A sort an older build saved
 *  (`ready`, `blocked`, `smallest`, `largest`) reads as the default, so a
 *  saved view or a device preference that used it keeps its other choices. */
const REMOVED_PR_SORTS = new Set(['ready', 'blocked', 'smallest', 'largest'])
export const prSortSchema = z.preprocess(
  (value) => (typeof value === 'string' && REMOVED_PR_SORTS.has(value) ? 'updated' : value),
  z.enum(['updated', 'created', 'oldest'])
)
export type PrSort = z.infer<typeof prSortSchema>
export const PR_SORT_OPTIONS: Array<{ value: PrSort; label: string }> = [
  { value: 'updated', label: 'Recently updated' },
  { value: 'created', label: 'Newest created' },
  { value: 'oldest', label: 'Oldest updated' }
]
const label = z.string().min(1).max(256)
export const prViewFiltersSchema = z
  .object({
    hostId: z.string().max(256).nullable(),
    project: z
      .object({ hostId: z.string().max(256), projectPath: z.string().max(4096) })
      .strict()
      .nullable(),
    query: z.string().max(1000),
    state: z.enum(['open', 'merged', 'closed', 'all']),
    involvement: z.enum(['all', 'authored', 'assigned', 'reviewing', 'others']),
    labels: z
      .array(z.array(label).min(1).max(20))
      .max(20)
      .refine(
        (groups) => groups.reduce((count, group) => count + group.length, 0) <= 100,
        'too_many_labels'
      ),
    excludedLabels: z.array(label).max(100),
    author: z.string().max(256).nullable(),
    draft: z.enum(['all', 'only', 'hide']),
    review: z.enum(['all', 'approved', 'changes-requested', 'review-required', 'none']),
    checks: z.enum(['all', 'pending', 'passing', 'failing']),
    sort: prSortSchema,
    guide: z.boolean().default(false),
    lens: z.boolean().default(false)
  })
  .strict()
  .refine(
    (filters) => !filters.project || !filters.hostId || filters.project.hostId === filters.hostId,
    'project_host_mismatch'
  )
export type PrViewFilters = z.infer<typeof prViewFiltersSchema>
export const prSavedViewSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(100),
    filters: prViewFiltersSchema
  })
  .strict()
export type PrSavedView = z.infer<typeof prSavedViewSchema>
export const prSavedViewsSchema = z
  .array(prSavedViewSchema)
  .max(50)
  .refine(
    (views) => new Set(views.map((view) => view.id)).size === views.length,
    'duplicate_view_id'
  )
export function putPrSavedView(views: readonly PrSavedView[], view: PrSavedView): PrSavedView[] {
  const parsed = prSavedViewSchema.parse(view)
  return prSavedViewsSchema.parse([...views.filter((held) => held.id !== parsed.id), parsed])
}
