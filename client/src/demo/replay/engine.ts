import type { NormalizedEvent } from '../../../../src/shared/types'
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
  tabId: string
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
    const { tabId } = pendingPermission
    pendingPermission = null
    if (autoContinueTimer) clearTimeout(autoContinueTimer)
    autoContinueTimer = null
    backend.broadcast('normalized-event', tabId, {
      type: 'permission_resolved',
      questionId,
    } satisfies NormalizedEvent)
    releaseWaiters()
    return true
  }

  backend.register('respondPermission', (args) => {
    const [, questionId, optionId] = args as [unknown, string, string]
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
          tabId: step.tabId,
          defaultOptionId: defaultOption?.id ?? '',
        }
      }

      backend.broadcast('normalized-event', step.tabId, step.event)

      if (step.event.type === 'permission_request' && pendingPermission?.questionId === step.event.questionId) {
        const { questionId, defaultOptionId } = pendingPermission
        autoContinueTimer = setTimeout(() => {
          resolvePermission(questionId, defaultOptionId)
        }, AUTO_CONTINUE_MS)
        await waitUntilRunnable()
      }
    }
    isDone = true
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
