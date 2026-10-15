import type {
  AgentId,
  GitCheckout,
  IpcContext,
  RunConfig,
} from '@solus/contracts/types'
import { checkoutGit, checkoutPlace } from '../../../contexts/workspace/run-location'

export interface DraftPluginCommandScope {
  workingDirectory: string
  provider: AgentId
  modelId: string | null
  context: IpcContext
}

/**
 * What a draft's slash commands depend on: the host and folder they are read
 * from, and the provider and model its pickers name. Two models of one
 * provider are distinct, so a model change reads the commands again. Git state
 * is not part of it — a Git answer landing on the draft is no reason to ask.
 */
export function draftPluginCommandIdentity(run: RunConfig, fallbackProvider: AgentId): string {
  const place = checkoutPlace(run)
  return `${place.serverId}\0${place.path}\0${run.provider ?? fallbackProvider}\0${run.modelConfig.modelId ?? ''}`
}

/** Build command discovery from the draft's picker selection, not the active tab. */
export function draftPluginCommandScope(
  run: RunConfig,
  fallbackProvider: AgentId,
  draftId: string,
  contextForEnvironment: (
    workingDirectory: string,
    gitContext: GitCheckout | null,
    sourceId: string,
  ) => IpcContext,
): DraftPluginCommandScope {
  const provider = run.provider ?? fallbackProvider
  const context = contextForEnvironment(
    checkoutPlace(run).path,
    checkoutGit(run),
    draftId,
  )
  context.session.provider = provider
  context.session.preferredModel = run.modelConfig.modelId
  return {
    workingDirectory: checkoutPlace(run).path,
    provider,
    modelId: run.modelConfig.modelId,
    context,
  }
}
