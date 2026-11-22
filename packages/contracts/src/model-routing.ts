import { z } from 'zod'
import { MODEL_PROFILES } from './types'

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

/** What each category covers. Auto's classifier chooses by these, and a task
 *  lead routes its workers by the same words. */
export const ROUTING_DESCRIPTIONS = {
  ui: 'Design or implement a user interface, visual layout, styling, or user interaction.',
  general: 'General assistance, explanation, routine work, or no clear specialist category.',
  exploration: 'Investigate, research, brainstorm, or explore options with an open outcome.',
  structured: 'Execute a well-defined task or fix with clear requirements and a bounded outcome.',
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
  exploration: 'claude-fable-5-2',
  structured: 'gpt-6-sol',
}

/** The model a category routes to and the provider whose profiles list it. A
 *  model no profile lists falls back to the general model, as Auto does; null
 *  when neither is listed. */
export function routedModel(config: ModelRouting, category: RoutingCategory): { provider: RoutingProvider; model: string } | null {
  for (const key of [category, 'general'] as const) {
    const provider = ROUTING_PROVIDERS.find(candidate => MODEL_PROFILES[candidate]?.[config[key]])
    if (provider) return { provider, model: config[key] }
  }
  return null
}
