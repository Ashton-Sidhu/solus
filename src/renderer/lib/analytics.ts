import posthog from 'posthog-js'

const POSTHOG_KEY = (import.meta as any).env?.VITE_POSTHOG_KEY as string | undefined
const POSTHOG_HOST = ((import.meta as any).env?.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com'
const ANON_ID_KEY = 'solus-analytics-id'

function getOrCreateAnonId(): string {
  let id = localStorage.getItem(ANON_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(ANON_ID_KEY, id)
  }
  return id
}

export function initAnalytics(enabled: boolean): void {
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
      if (!enabled) ph.opt_out_capturing()
    },
  })
}

export function setAnalyticsEnabled(enabled: boolean): void {
  if (!POSTHOG_KEY) return
  if (enabled) {
    posthog.opt_in_capturing()
  } else {
    posthog.opt_out_capturing()
  }
}

function capture(event: string, props?: Record<string, unknown>): void {
  if (!POSTHOG_KEY) return
  posthog.capture(event, props)
}

export const analytics = {
  appOpened: () => capture('app_opened'),
  conversationStarted: (props: { agent: string }) => capture('conversation_started', props),
  messageSent: (props: { agent: string; isFirstMessage: boolean }) => capture('message_sent', props),
  agentSwitched: (props: { from: string; to: string }) => capture('agent_switched', props),
  settingsOpened: () => capture('settings_opened'),
  modeToggled: (props: { mode: 'editor' | 'pill' }) => capture('mode_toggled', props),
  voiceRecordingStarted: () => capture('voice_recording_started'),
  planGalleryOpened: () => capture('plan_gallery_opened'),
}
