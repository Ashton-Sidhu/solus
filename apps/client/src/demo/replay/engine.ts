import { arg } from '../handlers/args'
import type { WireNormalizedEvent } from '@solus/contracts/types'
import type { DemoBackend } from '../server'
import type { DemoStore } from '../store'

const AUTO_CONTINUE_MS = 20_000

export interface ReplayEngine {
  readonly isDone: boolean
  readonly isStarted: boolean
  readonly hydrated: Promise<void>
  start(): void
  pause(): void
  resume(): void
}

interface ReplayEngineOptions {
  hydrated: Promise<void>
}

interface PendingPermission {
  questionId: string
  sessionId: string
  defaultOptionId: string
}

export function createReplayEngine(
  backend: DemoBackend,
  store: DemoStore,
  options: ReplayEngineOptions,
): ReplayEngine {
  const steps = store.fixtures.replayScript
  let isDone = false
  let isStarted = false
  let isPaused = false
  let pendingPermission: PendingPermission | null = null
  let autoContinueTimer: ReturnType<typeof setTimeout> | null = null
  const resumeWaiters = new Set<() => void>()

  const canContinue = (): boolean => !isPaused && pendingPermission === null

  const releaseWaiters = (): void => {
    if (!canContinue()) return
    for (const resolve of resumeWaiters) resolve()
    resumeWaiters.clear()
  }

  const waitUntilRunnable = (): Promise<void> => {
    if (canContinue()) return Promise.resolve()
    return new Promise((resolve) => resumeWaiters.add(resolve))
  }

  const resolvePermission = (questionId: string, _optionId: string): boolean => {
    if (pendingPermission?.questionId !== questionId) return false
    const { sessionId } = pendingPermission
    pendingPermission = null
    if (autoContinueTimer) clearTimeout(autoContinueTimer)
    autoContinueTimer = null
    backend.broadcast('session.eventReceived', {
      sessionId,
      event: { type: 'permission_resolved', questionId } satisfies WireNormalizedEvent,
    })
    releaseWaiters()
    return true
  }

  backend.register('respondPermission', (args) => {
    const questionId = arg<string>(args, 1)
    const optionId = arg<string>(args, 2)
    return resolvePermission(questionId, optionId)
  })

  const play = async (): Promise<void> => {
    await options.hydrated
    for (const step of steps) {
      await new Promise<void>((resolve) => setTimeout(resolve, step.delayMs))
      await waitUntilRunnable()

      if (step.event.type === 'permission_request') {
        const defaultOption = step.event.options.find((option) => option.kind?.startsWith('allow'))
          ?? step.event.options[0]
        pendingPermission = {
          questionId: step.event.questionId,
          sessionId: step.sessionId,
          defaultOptionId: defaultOption?.id ?? '',
        }
      }

      backend.broadcast('session.eventReceived', { sessionId: step.sessionId, event: step.event })

      if (step.event.type === 'permission_request' && pendingPermission?.questionId === step.event.questionId) {
        const { questionId, defaultOptionId } = pendingPermission
        autoContinueTimer = setTimeout(() => {
          resolvePermission(questionId, defaultOptionId)
        }, AUTO_CONTINUE_MS)
        await waitUntilRunnable()
      }
    }
    isDone = true
    // A finished turn folds its whole activity into one summary row, so the
    // transcript the replay just built collapses to a prompt and a single
    // line. That is right in the app and wrong in a hero: every visitor who
    // stays past the run, or scrolls back up, meets an empty window. Tell the
    // page so it can play the story again.
    window.parent.postMessage({ type: 'demo:complete' }, '*')
  }

  return {
    get isDone() { return isDone },
    get isStarted() { return isStarted },
    hydrated: options.hydrated,
    start() {
      if (isStarted) return
      isStarted = true
      void play()
    },
    pause() {
      isPaused = true
    },
    resume() {
      isPaused = false
      releaseWaiters()
    },
  }
}

export function armReplay(engine: ReplayEngine): void {
  let hydrated = false
  let startRequested = window.self === window.top

  const startIfReady = (): void => {
    if (hydrated && startRequested) engine.start()
  }

  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'demo:start') return
    startRequested = true
    startIfReady()
  })

  void engine.hydrated.then(() => {
    hydrated = true
    window.parent.postMessage({ type: 'demo:ready' }, '*')
    startIfReady()
  })
}
