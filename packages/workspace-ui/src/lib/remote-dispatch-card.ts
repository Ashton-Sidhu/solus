import type { StatusCardState, StatusCardStep } from '@solus/contracts/types'
import { AGENT_SETUP_STEP, WORKTREE_SETUP_STEPS } from '@solus/contracts/setup-card'

export type RemoteDispatchPhase = 'connecting' | 'repository' | 'ready'

export interface RemoteDispatchCardOptions {
  tabId: string
  hostLabel: string
  phase: RemoteDispatchPhase
  error?: {
    step: 'connection' | 'repository'
    message: string
  }
}

/** The host's own steps, which its card reports once the prompt reaches it. */
const FUTURE_STEPS: StatusCardStep[] = [...WORKTREE_SETUP_STEPS, AGENT_SETUP_STEP].map((step): StatusCardStep => ({ ...step, status: 'pending' }))

/** One card that begins in the host picker and hands off to backend setup. */
export function buildRemoteDispatchCard(options: RemoteDispatchCardOptions): StatusCardState {
  const { tabId, hostLabel, phase, error } = options
  const connectionDone = phase !== 'connecting' || error?.step === 'repository'
  const repositoryDone = phase === 'ready'
  const connectionStep: StatusCardStep = {
      id: 'connection',
      label: `Connecting to ${hostLabel}`,
      status: error?.step === 'connection' ? 'error' : connectionDone ? 'done' : 'active',
    }
  if (error?.step === 'connection') connectionStep.detail = error.message
  const repositoryStep: StatusCardStep = {
      id: 'repository',
      label: 'Preparing repository',
      status: error?.step === 'repository'
        ? 'error'
        : repositoryDone
          ? 'done'
          : phase === 'repository'
            ? 'active'
            : 'pending',
    }
  if (error?.step === 'repository') repositoryStep.detail = error.message
  const steps: StatusCardStep[] = [
    connectionStep,
    repositoryStep,
    ...FUTURE_STEPS.map((step) => ({ ...step })),
  ]
  const card: StatusCardState = {
    id: `remote-dispatch-${tabId}`,
    title: error ? `Couldn’t prepare ${hostLabel}` : `Starting on ${hostLabel}`,
    icon: 'server',
    status: error ? 'error' : 'active',
    steps,
  }
  return card
}

/**
 * The host's setup card arrives after the prompt is sent. Preserve the steps
 * the client already finished so the conversation shows one continuous
 * operation instead of replacing it halfway through. A host card that copies
 * the repository reports that step itself, so only the connection is kept.
 */
export function mergeRemoteDispatchProgress(
  current: StatusCardState | null,
  incoming: StatusCardState,
): StatusCardState {
  if (!current?.id.startsWith('remote-dispatch-') || !incoming.id.startsWith('worktree-')) {
    return incoming
  }
  const hostPreparesRepository = incoming.steps.some((step) => step.id === 'repository')
  const preparationSteps = current.steps
    .filter((step) => step.id === 'connection' || (step.id === 'repository' && !hostPreparesRepository))
    .map((step) => ({ ...step, status: 'done' as const, detail: undefined }))
  return {
    ...incoming,
    id: current.id,
    title: incoming.status === 'error' ? incoming.title : current.title,
    icon: current.icon,
    steps: [...preparationSteps, ...incoming.steps],
  }
}
