import type { AppNoticeEvent, NotificationChannel, SessionNotificationEvent } from '@solus/contracts/notification-types'
import type { RateLimitBehavior, ResponseStreamingMode } from '@solus/contracts/settings'
import type { SettingsSyncState } from '@solus/client-core/settings-sync'
import type { AppearanceMode } from '../appearance'

/** The words the settings screens show for each choice. */

export const APPEARANCE_LABELS = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
} as const satisfies Record<AppearanceMode, string>

export const APPEARANCE_DESCRIPTIONS = {
  system: 'Follow this device’s light or dark setting.',
  light: 'Always light.',
  dark: 'Always dark.',
} as const satisfies Record<AppearanceMode, string>

/** In the desktop's words (`SettingsTabGeneral.svelte`). */
export const STREAMING_CHOICES: readonly { mode: ResponseStreamingMode; label: string; description: string }[] = [
  { mode: 'paragraph', label: 'Streaming', description: 'Show paragraphs and code blocks as they finish.' },
  { mode: 'buffered', label: 'Buffered', description: 'Wait for each segment.' },
]

/** In the desktop's order and words (`RateLimitSetting.svelte`). */
export const RATE_LIMIT_CHOICES: readonly { mode: RateLimitBehavior; label: string }[] = [
  { mode: 'ask', label: 'Ask' },
  { mode: 'queue', label: 'Queue' },
  { mode: 'stop', label: 'Stop' },
  { mode: 'continue', label: 'Continue' },
]

/** How a host's notifications reach a person, in the desktop's words. */
export const NOTIFICATION_CHANNEL_LABELS = {
  system: 'System notifications',
  sound: 'Sound',
  toast: 'In-app banners',
} as const satisfies Record<NotificationChannel, string>

/** What an agent did; delivered through the channels above. */
export const SESSION_EVENT_LABELS = {
  needs_approval: 'Needs approval',
  question: 'Asks a question',
  plan_ready: 'Plan ready',
  turn_finished: 'Turn finished',
  session_failed: 'Session failed',
  work_created: 'Work created',
  task_created: 'Task created',
  automation_saved: 'Automation saved',
  agent_conversation: 'Agents talking to each other',
} as const satisfies Record<SessionNotificationEvent, string>

/** What happened around the workspace; always an in-app notice. */
export const APP_NOTICE_LABELS = {
  review_guide_ready: 'Review guide ready',
  review_lens_ready: 'Review lens ready',
  work_review: 'Review requested on a work',
  update_available: 'Update available',
  host_discovered: 'Host found nearby',
  teammate_presence: 'Teammate joins a session',
  share_revoked: 'Share revoked',
} as const satisfies Record<AppNoticeEvent, string>

/** Personal sync on this device, in one or two words (plans/018 §5). Never "Synced" for an unconfirmed edit. */
export const SYNC_STATE_LABELS = {
  'signed-out': 'Signed out',
  off: 'Off',
  loading: 'Checking…',
  synced: 'Synced',
  pending: 'Waiting to send',
  offline: 'Offline',
  conflict: 'Needs your choice',
  error: 'Not synced',
} as const satisfies Record<SettingsSyncState, string>
