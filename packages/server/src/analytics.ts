import { PostHog } from 'posthog-node'
import { getInstallationId } from './server/auth'
import { getHostConfig } from './server/settings'
import { createLogger } from './logger'
import type { ServerEventMap } from '@solus/contracts/analytics-events'
import { TELEMETRY_SHUTDOWN_TIMEOUT_MS } from './observability/telemetry-shutdown'

const log = createLogger('main', 'analytics')

let client: PostHog | null = null

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

export async function shutdownAnalytics(): Promise<void> {
  if (!client) return

  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      client.shutdown(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, TELEMETRY_SHUTDOWN_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    log.info('analytics_shutdown', {})
  }
}
