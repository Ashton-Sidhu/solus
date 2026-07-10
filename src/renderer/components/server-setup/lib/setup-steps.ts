import type { ServerCapabilities } from '../../../../shared/types'

export type SetupChecklistStepId = 'install-claude' | 'claude-auth' | 'github' | 'project'

export function setupStepIdsForCapabilities(capabilities: ServerCapabilities | null | undefined): SetupChecklistStepId[] {
  if (!capabilities) return []
  const steps: SetupChecklistStepId[] = []
  if (!capabilities.agents.claude) steps.push('install-claude')
  if (!capabilities.agentAuth.claude) steps.push('claude-auth')
  if (!capabilities.gitAuth.github) steps.push('github')
  if (capabilities.projectCount === 0) steps.push('project')
  return steps
}

export function hasSetupGaps(capabilities: ServerCapabilities | null | undefined): boolean {
  return setupStepIdsForCapabilities(capabilities).length > 0
}
