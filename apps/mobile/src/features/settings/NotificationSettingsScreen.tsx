import { APP_NOTICE_EVENTS, NOTIFICATION_CHANNELS, SESSION_NOTIFICATION_EVENTS } from '@solus/contracts/notification-types'
import type { PersonalSettings } from '@solus/contracts/settings'
import { useApp, useListened } from '../../app/app-context'
import type { ScreenProps } from '../../navigation/routes'
import { APP_NOTICE_LABELS, NOTIFICATION_CHANNEL_LABELS, SESSION_EVENT_LABELS } from './lib/settings-labels'
import { GroupedScroll, GroupedSection, SwitchRow } from '../../ui/grouped-rows'

/**
 * What you are told about, and how: the person's own choice (plans/018), not
 * one host's. Two axes, as on the desktop: a notification goes out only when
 * its event is on and its channel is on. This device's permission to show
 * notifications stays with the device.
 */
export function NotificationSettingsScreen(_props: ScreenProps<'NotificationSettings'>) {
  const app = useApp()
  const { channels, events } = useListened(app.personal.changes, app.personal.current).notifications
  const update = (change: (next: PersonalSettings['notifications']) => void) => {
    const next = structuredClone(app.personal.current().notifications)
    change(next)
    app.personal.set({ notifications: next })
  }
  return (
    <GroupedScroll>
      <GroupedSection title="Delivery" footer="How your clients alert you.">
        {NOTIFICATION_CHANNELS.map((channel) => (
          <SwitchRow key={channel} label={NOTIFICATION_CHANNEL_LABELS[channel]} value={channels[channel]} onChange={(on) => update((next) => { next.channels[channel] = on })} />
        ))}
      </GroupedSection>
      <GroupedSection title="Session events" footer="What an agent did. Delivered through the channels above.">
        {SESSION_NOTIFICATION_EVENTS.map((event) => (
          <SwitchRow key={event} label={SESSION_EVENT_LABELS[event]} value={events[event]} onChange={(on) => update((next) => { next.events[event] = on })} />
        ))}
      </GroupedSection>
      <GroupedSection title="Workspace notices" footer="Things that happen around your work. Always shown in the app.">
        {APP_NOTICE_EVENTS.map((event) => (
          <SwitchRow key={event} label={APP_NOTICE_LABELS[event]} value={events[event]} onChange={(on) => update((next) => { next.events[event] = on })} />
        ))}
      </GroupedSection>
    </GroupedScroll>
  )
}
