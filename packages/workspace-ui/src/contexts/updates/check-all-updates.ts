import { updatesStore } from './updates.store.svelte'
import { hostUpdatesStore } from './host-updates.store.svelte'

/** One user command covers both the client app and all connected hosts. */
export async function checkAllUpdates(): Promise<void> {
  await Promise.allSettled([
    ...(updatesStore.isAvailable ? [updatesStore.check()] : []),
    hostUpdatesStore.checkAll(),
  ])
}
