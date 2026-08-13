import posthog from 'posthog-js'
import type { SolusEventMap } from '../../shared/analytics-events'

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY
const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com'
const ANON_ID_KEY = 'solus-analytics-id'
let initialized = false

function getOrCreateAnonId(): string {
  let id = localStorage.getItem(ANON_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(ANON_ID_KEY, id)
  }
  return id
}

export function initAnalytics(opts: {
  enabled: boolean
  platform: 'desktop' | 'web-desktop' | 'web-mobile'
  viewMode: 'pill' | 'editor'
}): void {
  if (!POSTHOG_KEY) return
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    person_profiles: 'identified_only',
    capture_pageview: false,
    capture_pageleave: false,
    autocapture: false,
    disable_session_recording: true,
    loaded: (ph) => {
      ph.identify(getOrCreateAnonId())
      if (!opts.enabled) ph.opt_out_capturing()
    },
  })
  posthog.register({ platform: opts.platform, view_mode: opts.viewMode })
  initialized = true
}

export function setAnalyticsEnabled(enabled: boolean): void {
  if (!POSTHOG_KEY) return
  if (enabled) {
    posthog.opt_in_capturing()
  } else {
    posthog.opt_out_capturing()
  }
}

export function track<E extends keyof SolusEventMap>(event: E, props: SolusEventMap[E]): void {
  if (!POSTHOG_KEY || !initialized) return
  posthog.capture(event, props)
}

export function identifyInstallation(installationId: string): void {
  if (!POSTHOG_KEY || !initialized) return
  posthog.identify(installationId)
}

export function registerSuperProps(
  props: Partial<{ platform: string; view_mode: string; app_version: string }>,
): void {
  if (!POSTHOG_KEY || !initialized) return
  posthog.register(props)
}
