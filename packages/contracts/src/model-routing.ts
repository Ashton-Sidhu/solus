import { z } from 'zod'

export const AUTO_MODEL_ID = 'auto'
export const ROUTING_PROVIDERS = ['claude-code', 'codex'] as const
export const ROUTING_CATEGORIES = ['ui', 'general', 'exploration', 'structured'] as const
export type RoutingCategory = (typeof ROUTING_CATEGORIES)[number]
export type RoutingProvider = (typeof ROUTING_PROVIDERS)[number]

export const ROUTING_LABELS = {
  ui: 'User interface',
  general: 'General use',
  exploration: 'Open-ended exploration',
  structured: 'Well-defined task',
} satisfies Record<RoutingCategory, string>

/** One model per category. A model id names its own provider, so the host needs
 *  no second choice; a model no installed provider offers falls back at routing time. */
const routeSchema = z.string().trim().min(1).max(200).refine(value => value !== AUTO_MODEL_ID)

export const modelRoutingSchema = z.object({
  ui: routeSchema,
  general: routeSchema,
  exploration: routeSchema,
  structured: routeSchema,
}).strict()
export type ModelRouting = z.infer<typeof modelRoutingSchema>

export const DEFAULT_MODEL_ROUTING: ModelRouting = {
  ui: 'claude-opus-5-5',
  general: 'gpt-6-sol',
  exploration: 'claude-fable-5-1',
  structured: 'gpt-6-sol',
}
