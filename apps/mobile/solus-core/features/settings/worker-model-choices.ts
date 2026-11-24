import type { WorkerModelSelection } from '@solus/contracts/settings'
import { PROVIDERS, modelChoices } from '../conversation/lib/run-settings'

/** One row of the worker model or fallback model list. No selection is the row that turns the setting off. */
export interface WorkerModelChoice {
  key: string
  label: string
  selection: WorkerModelSelection | null
}

/**
 * The rows of a worker model setting: `offLabel` first, then each model of
 * each provider. A saved model that the list hides (a legacy model) stays, so
 * the saved value always has its row.
 */
export function workerModelChoices(current: WorkerModelSelection | null, offLabel: string): WorkerModelChoice[] {
  const models = PROVIDERS.flatMap((provider) => {
    if (provider.id !== 'claude-code' && provider.id !== 'codex') return []
    const id = provider.id
    return modelChoices(id, current?.provider === id ? current.model : null).map((model): WorkerModelChoice => ({
      key: `${id}:${model.id}`,
      label: `${provider.label} · ${model.label}`,
      selection: { provider: id, model: model.id, reasoningEffort: undefined },
    }))
  })
  if (current && !models.some((choice) => isWorkerModelChoiceSelected(choice, current))) {
    models.push({ key: `${current.provider}:${current.model}`, label: current.model, selection: current })
  }
  return [{ key: 'off', label: offLabel, selection: null }, ...models]
}

export function isWorkerModelChoiceSelected(choice: WorkerModelChoice, current: WorkerModelSelection | null): boolean {
  return choice.selection === null
    ? current === null
    : current?.provider === choice.selection.provider && current.model === choice.selection.model
}

/** What a tap on a row saves. The saved model again keeps its reasoning level; another model runs at its own default. */
export function workerModelAfterChoice(choice: WorkerModelChoice, current: WorkerModelSelection | null): WorkerModelSelection | null {
  return isWorkerModelChoiceSelected(choice, current) ? current : choice.selection
}
