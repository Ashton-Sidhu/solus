import { subscribeAllHosts } from '@solus/client-core/host-events'
import { toasts } from '../../lib/toasts'
import type { WatchesStore } from './watches.store.svelte'
import { watchEndNotice } from './watch-notice'

/** Keep the store live from every host and tell the person about the ends
 *  they would not see otherwise. Both client boots call this once. */
export function subscribeWatchChanges(store: WatchesStore): () => void {
  return subscribeAllHosts('watch.changed', (serverId, event) => {
    const notice = watchEndNotice(store.applyChange(serverId, event), event.watch)
    if (!notice) return
    if (event.watch.status === 'done') toasts.success(notice)
    else toasts.error(notice)
  })
}
