import type { Model } from './generated/v2/Model'

let listedModels: Model[] = []

/** The models the host's Codex reports in `model/list`. */
export function rememberCodexModels(models: Model[]): void {
  listedModels = models
}

/**
 * The model a background writing run asks the host's Codex for. A ChatGPT login
 * can leave the writing model out of its catalog, and Codex then refuses the run.
 * An unread list keeps the request. Otherwise an unlisted model gives way to the
 * account's default, then to its first current model.
 */
export function codexWritingModel(requested: string, models: Model[] = listedModels): string {
  if (!models.length || models.some((model) => model.model === requested)) return requested
  return (models.find((model) => model.isDefault) ?? models.find((model) => !model.upgrade) ?? models[0]!).model
}
