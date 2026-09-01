import { PostHog } from 'posthog-node'
import { getInstallationId } from './server/auth'
import { getHostConfig } from './server/settings'
import { createLogger, setLogEventSink } from './logger'
import type { ServerEventMap } from '@solus/contracts/analytics-events'

const log = createLogger('main', 'analytics')
const SHUTDOWN_TIMEOUT_MS = 1_500

let client: PostHog | null = null

type BridgedLogEvent = Extract<keyof ServerEventMap,
  'worktree_created' | 'automation_run_succeeded' | 'automation_run_failed' |
  'skill_installed' | 'pair_token_generated' | 'model_installed'>

export const BRIDGED_LOG_EVENTS = new Set<string>([
  'worktree_created',
  'automation_run_succeeded',
  'automation_run_failed',
  'skill_installed',
  'pair_token_generated',
  'model_installed',
])

function isBridgedLogEvent(message: string): message is BridgedLogEvent {
  return BRIDGED_LOG_EVENTS.has(message)
}

function getClient(): PostHog | null {
  const apiKey = process.env.SOLUS_POSTHOG_KEY
  if (!apiKey) return null

  if (!client) {
    client = new PostHog(apiKey, {
      host: 'https://us.i.posthog.com',
      flushAt: 5,
      flushInterval: 5_000,
    })
    log.info('analytics_initialized', {})
  }

  return client
}

export function captureServerEvent<E extends keyof ServerEventMap>(event: E, props: ServerEventMap[E]): void {
  if (!process.env.SOLUS_POSTHOG_KEY) return
  if (!getHostConfig().config.analyticsEnabled) return

  const posthog = getClient()
  if (!posthog) return

  posthog.capture({
    distinctId: getInstallationId(),
    event,
    properties: props,
  })
}

export function captureBridgedLogEvent(
  msg: string,
  capture: (event: BridgedLogEvent, props: ServerEventMap[BridgedLogEvent]) => void = captureServerEvent,
): void {
  if (isBridgedLogEvent(msg)) {
    capture(msg, {})
  }
}

/** Installs the privacy-safe logger bridge without introducing a logger-to-analytics import. */
export function initLogEventBridge(): void {
  setLogEventSink((msg) => captureBridgedLogEvent(msg))
}

initLogEventBridge()

export async function shutdownAnalytics(): Promise<void> {
  if (!client) return

  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      client.shutdown(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    log.info('analytics_shutdown', {})
  }
}
