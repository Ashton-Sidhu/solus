import { z } from 'zod'

export const taskViewFiltersSchema = z
  .object({
    sourceKey: z.string().max(1024).nullable(),
    query: z.string().max(1000),
    layout: z.enum(['list', 'board']),
    sort: z.enum(['created', 'updated', 'priority', 'due']),
    involvement: z.enum(['all', 'authored', 'assigned', 'mentioned']),
    runningOnly: z.boolean(),
    overdueOnly: z.boolean(),
    assignedOnly: z.boolean(),
    columnIds: z.array(z.string().max(256)).max(100).nullable()
  })
  .strict()
export type TaskViewFilters = z.infer<typeof taskViewFiltersSchema>

export const taskSavedViewSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(100),
    filters: taskViewFiltersSchema
  })
  .strict()
export type TaskSavedView = z.infer<typeof taskSavedViewSchema>

/** A saved view is a bounded personal preference, never a copy of tasks. */
export const issueSavedViewsSchema = z
  .array(taskSavedViewSchema)
  .max(50)
  .refine(
    (views) => new Set(views.map((view) => view.id)).size === views.length,
    'duplicate_view_id'
  )

export function putTaskSavedView(
  views: readonly TaskSavedView[],
  view: TaskSavedView
): TaskSavedView[] {
  const parsed = taskSavedViewSchema.parse(view)
  return issueSavedViewsSchema.parse([...views.filter((held) => held.id !== parsed.id), parsed])
}
