import { liveActivityRegistrationSchema } from '@solus/contracts/live-activity'
import { liveActivityPushTokenSchema } from '@solus/contracts/uplink'
import type { LiveActivityRelay } from '../../host/live-activity-relay'
import type { SolusServer } from '../server'

/** The phone's Live Activity card and its push token (docs/plans/live-activity-push.md). */
export function registerLiveActivityHandlers(server: SolusServer, relay: LiveActivityRelay): void {
  server.register('liveActivityRegister', (args) => {
    relay.register(liveActivityRegistrationSchema.parse(args[0]))
  })

  server.register('liveActivityUnregister', (args) => {
    relay.unregister(liveActivityPushTokenSchema.parse(args[0]))
  })
}
