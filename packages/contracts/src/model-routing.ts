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

const routeSchema = z.object({
  preferredProvider: z.enum(ROUTING_PROVIDERS),
  'claude-code': z.string().trim().min(1).max(200).refine(value => value !== AUTO_MODEL_ID),
  codex: z.string().trim().min(1).max(200).refine(value => value !== AUTO_MODEL_ID),
}).strict()

export const modelRoutingSchema = z.object({
  ui: routeSchema,
  general: routeSchema,
  exploration: routeSchema,
  structured: routeSchema,
}).strict()
export type ModelRouting = z.infer<typeof modelRoutingSchema>

export const DEFAULT_MODEL_ROUTING: ModelRouting = {
  ui: { preferredProvider: 'claude-code', 'claude-code': 'claude-opus-5', codex: 'gpt-6-astra' },
  general: { preferredProvider: 'codex', 'claude-code': 'claude-opus-5', codex: 'gpt-5.6-sol' },
  exploration: { preferredProvider: 'claude-code', 'claude-code': 'claude-fable-5-1', codex: 'gpt-6-astra' },
  structured: { preferredProvider: 'codex', 'claude-code': 'claude-opus-5', codex: 'gpt-5.6-sol' },
}
