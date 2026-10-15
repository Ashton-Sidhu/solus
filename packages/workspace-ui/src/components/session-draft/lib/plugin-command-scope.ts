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
