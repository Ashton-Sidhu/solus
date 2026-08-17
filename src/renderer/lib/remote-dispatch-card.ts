import type { StatusCardState, StatusCardStep } from '../../shared/types'

export type RemoteDispatchPhase = 'connecting' | 'repository' | 'ready'

export interface RemoteDispatchCardOptions {
  tabId: string
  hostLabel: string
  phase: RemoteDispatchPhase
  error?: { step: 'connection' | 'repository'; message: string }
}

const FUTURE_STEPS: StatusCardStep[] = [
  { id: 'worktree', label: 'Creating branch & worktree', status: 'pending' },
  { id: 'workspace', label: 'Linking workspace', status: 'pending' },
  { id: 'session', label: 'Starting agent session', status: 'pending' },
]

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
  return {
    id: `remote-dispatch-${tabId}`,
    title: error ? `Couldn’t prepare ${hostLabel}` : `Starting on ${hostLabel}`,
    icon: 'server',
    status: error ? 'error' : 'active',
    steps,
  }
}

/**
 * Worktree progress originates in main after the prompt is sent. Preserve the
 * already-completed host/repository steps so the conversation shows one
 * continuous operation instead of replacing it halfway through.
 */
export function mergeRemoteDispatchProgress(
  current: StatusCardState | null,
  incoming: StatusCardState,
): StatusCardState {
  if (!current?.id.startsWith('remote-dispatch-') || !incoming.id.startsWith('worktree-')) {
    return incoming
  }
  const preparationSteps = current.steps
    .filter((step) => step.id === 'connection' || step.id === 'repository')
    .map((step) => ({ ...step, status: 'done' as const, detail: undefined }))
  return {
    ...incoming,
    id: current.id,
    title: incoming.status === 'error' ? incoming.title : current.title,
    icon: current.icon,
    steps: [...preparationSteps, ...incoming.steps],
  }
}
