import { selectedProviderInstance } from '@solus/contracts/provider-instance-models'
import type { AgentId } from '@solus/contracts/types'
import { resolveProjectRoot } from '../../project-config/project-config'
import { resolveHomePath } from '../../platform/paths'
import { captureActingScope } from '../../vault/acting-scope'
import { privateProviderInstances } from './provider-instances'

/** Auto must obey the same project enablement as a direct provider selection. */
export function providerAvailableForProject(provider: AgentId, cwd: string): boolean {
  const personKey = captureActingScope()?.personKey
  if (!personKey || (provider !== 'codex' && provider !== 'claude-code')) return true
  const root = cwd ? resolveProjectRoot(resolveHomePath(cwd)) : undefined
  return selectedProviderInstance(privateProviderInstances().snapshot(personKey), provider, root).enabled
}
