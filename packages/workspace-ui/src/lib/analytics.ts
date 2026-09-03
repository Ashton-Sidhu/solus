import type { PostHog } from 'posthog-js'
import type { SolusEventMap } from '@solus/contracts/analytics-events'
import { uuid } from '@solus/contracts/uuid'

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY
const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com'
const ANON_ID_KEY = 'solus-analytics-id'

/**
 * posthog-js is loaded on demand rather than imported at module scope.
 *
 * `initAnalytics` is called from App.svelte's mount, so a static import put the
 * whole SDK on the path between the boot shell and the first painted frame —
 * for a library that reports on the app rather than drawing any of it. Nothing
 * here is awaited by a caller: the API stays fire-and-forget, and calls made
 * before the SDK resolves are queued and replayed in order.
 */
let posthog: PostHog | null = null
let loading = false
const pending: ((ph: PostHog) => void)[] = []

function whenLoaded(run: (ph: PostHog) => void): void {
  if (posthog) {
    run(posthog)
    return
  }
  // Before `initAnalytics`, there is nothing to queue against — the same drop
  // the `initialized` flag used to make.
  if (loading) pending.push(run)
}

function getOrCreateAnonId(): string {
  let id = localStorage.getItem(ANON_ID_KEY)
  if (!id) {
    id = uuid()
    localStorage.setItem(ANON_ID_KEY, id)
  }
  return id
}

export function initAnalytics(opts: {
  enabled: boolean
  platform: 'desktop' | 'web-desktop' | 'web-mobile'
  viewMode: 'pill' | 'editor'
}): void {
  if (!POSTHOG_KEY || loading) return
  loading = true
  void import('posthog-js').then(({ default: loaded }) => {
    loaded.init(POSTHOG_KEY, {
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
    loaded.register({ platform: opts.platform, view_mode: opts.viewMode })
    posthog = loaded
    for (const run of pending.splice(0)) run(loaded)
  })
}

export function setAnalyticsEnabled(enabled: boolean): void {
  whenLoaded((ph) => {
    if (enabled) ph.opt_in_capturing()
    else ph.opt_out_capturing()
  })
}

export function track<E extends keyof SolusEventMap>(event: E, props: SolusEventMap[E]): void {
  whenLoaded((ph) => ph.capture(event, props))
}

export function identifyInstallation(installationId: string): void {
  whenLoaded((ph) => ph.identify(installationId))
}

export function registerSuperProps(
  props: Partial<{ platform: string; view_mode: string; app_version: string }>,
): void {
  whenLoaded((ph) => ph.register(props))
}
