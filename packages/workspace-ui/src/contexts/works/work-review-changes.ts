import { subscribeAllHosts } from '@solus/client-core/host-events'
import { toasts } from '../../lib/toasts'
import { notificationsStore } from '../notifications/notifications.store.svelte'
import { presenceStore } from '../presence/presence.store.svelte'
import type { WorksStore } from './works.store.svelte'
import { workReviewNotice } from './work-review-notice'

/**
 * Keep every work's review, the gallery states, and the reader's review inbox
 * live from every host, and tell the reader when someone asks for their review
 * or decides on a work they sent. Both client boots call this once.
 */
export function subscribeWorkReviewChanges(works: WorksStore, openWork: (workId: string) => void): () => void {
  return subscribeAllHosts('workReviews.changed', (serverId, change) => {
    void works.reviews.applyChange(serverId, change).then((review) => {
      if (!notificationsStore.wants('work_review')) return
      const title = works.get(change.workId)?.title || works.reviews.inboxItem(change.workId)?.title || 'a work'
      const notice = workReviewNotice(change, review, presenceStore.currentUserId(serverId), title)
      if (notice) toasts.info(notice, { action: { label: 'Open', onAction: () => openWork(change.workId) } })
    })
  })
}
