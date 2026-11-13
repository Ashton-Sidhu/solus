import { appConfigValueProblem, type AppConfigField, type AppConfigValue } from '@solus/contracts/apps'
import type { AgentMetadata } from '@solus/contracts/types'

/**
 * The config fields of an app's Manage page (docs/plans/apps.md §4.4), on
 * desktop, web, and mobile: a text or a number field takes a draft that the
 * owner saves; a switch and a choice save at once. Pure, so the rules are
 * tested without a host.
 */

/** What the draft is: a value the field takes, or why it is not one. */
export type ConfigDraftResult = { value: AppConfigValue; problem: null } | { value: null; problem: string }

/** The value the owner typed for a text or a number field, checked against the field's declaration. */
export function parseConfigDraft(field: AppConfigField, draft: string): ConfigDraftResult {
  let value: AppConfigValue = draft
  if (field.type === 'number') {
    if (draft.trim() === '') return { value: null, problem: `${field.label} takes a number.` }
    value = Number(draft)
  }
  const problem = appConfigValueProblem(field, value)
  return problem ? { value: null, problem } : { value, problem: null }
}

/** One line under a number field that says its range, or null when it has none. */
export function configRangeHint(field: AppConfigField): string | null {
  if (field.type !== 'number') return null
  const whole = field.integer ? 'A whole number' : 'A number'
  if (field.min !== undefined && field.max !== undefined) return `${whole} from ${field.min} to ${field.max}.`
  if (field.min !== undefined) return `${whole}, at least ${field.min}.`
  if (field.max !== undefined) return `${whole}, at most ${field.max}.`
  return null
}

/** The default as the owner reads it. */
export function configDefaultText(field: AppConfigField): string {
  if (field.type === 'boolean') return field.default ? 'On' : 'Off'
  if (field.type === 'choice') return field.options.find((option) => option.value === field.default)?.label ?? field.default
  // An empty model setting is the model Solus writes with (docs/plans/app-models.md §4).
  if (field.type === 'model') return field.default || DEFAULT_MODEL_LABEL
  return field.default === '' ? 'empty' : String(field.default)
}

/** The empty value of a model setting: the model Solus writes with. */
export const DEFAULT_MODEL_LABEL = 'Solus default'

/**
 * The choices of a model setting: Solus's default, then each model the host
 * can run. A saved model the host no longer offers stays a choice, so the
 * select shows what is set.
 */
export function modelSettingOptions(agents: readonly AgentMetadata[], current: string): { value: string; label: string }[] {
  const options = [{ value: '', label: DEFAULT_MODEL_LABEL }]
  for (const agent of agents) {
    if (agent.available === false) continue
    for (const model of agent.models) options.push({ value: model.id, label: `${agent.label} · ${model.label}` })
  }
  if (current && !options.some((option) => option.value === current)) options.push({ value: current, label: `${current} (not on this host)` })
  return options
}
