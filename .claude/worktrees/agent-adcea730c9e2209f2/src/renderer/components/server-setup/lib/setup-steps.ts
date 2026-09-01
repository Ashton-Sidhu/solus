import type { ServerCapabilities } from '../../../../shared/types'

export type SetupChecklistStepId = 'install-claude' | 'claude-auth' | 'github' | 'project'

export type SetupJourneyStepId = 'server-name' | SetupChecklistStepId

export interface SetupJourneyStep {
  id: SetupJourneyStepId
  label: string
  title: string
  description: string
}

export const SETUP_JOURNEY_STEPS: readonly SetupJourneyStep[] = [
  {
    id: 'server-name',
    label: 'Name server',
    title: 'Name your server',
    description: 'Give this server a name clients will recognize.',
  },
  {
    id: 'install-claude',
    label: 'Install Claude',
    title: 'Install Claude Code',
    description: 'Install the agent CLI so sessions can run from any paired client.',
  },
  {
    id: 'claude-auth',
    label: 'Sign in',
    title: 'Sign in to Claude',
    description: 'Authorize Claude Code once on this server to start agent sessions.',
  },
  {
    id: 'github',
    label: 'Connect GitHub',
    title: 'Connect GitHub',
    description: 'Choose which repositories this server can access.',
  },
  {
    id: 'project',
    label: 'Clone project',
    title: 'Clone your first project',
    description: 'Pick a repository and Solus will prepare it in the server workspace.',
  },
]

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

export function completedSetupStepIds(capabilities: ServerCapabilities | null | undefined): SetupJourneyStepId[] {
  if (!capabilities) return []
  const steps: SetupJourneyStepId[] = []
  if (capabilities.serverName?.trim()) steps.push('server-name')
  if (capabilities.agents.claude) steps.push('install-claude')
  if (capabilities.agentAuth.claude) steps.push('claude-auth')
  if (capabilities.gitAuth.github) steps.push('github')
  if (capabilities.projectCount > 0) steps.push('project')
  return steps
}
