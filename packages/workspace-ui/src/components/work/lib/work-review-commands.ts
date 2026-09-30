import { Link, UserCheck } from '@lucide/svelte'
import { sharesStore } from '../../../contexts/sharing/shares.store.svelte'
import { visibleRef, type PaneEntry } from '../../../contexts/workspace/routing/location'
import type { Command } from '../../command-palette/lib/commands'
import type { WorksStore } from '../../../contexts/works/works.store.svelte'
import { toasts } from '../../../lib/toasts'

/**
 * The review commands a work offers outside its own header: the gallery's
 * card menu and the command palette. Each lands where the header's control
 * would, so every entry point behaves the same.
 */

/** Open the work with its Review popover showing. */
export function openWorkReview(surface: { worksStore: WorksStore; openWork(workId: string): void }, workId: string): void {
  surface.worksStore.reviews.showReview(workId)
  surface.openWork(workId)
}

/**
 * Copy the link a person outside the organization reviews through. A work
 * this host cannot make a link for (a Local work on a machine) opens the
 * Share dialog, where it is published into the organization first.
 */
export async function copyWorkReviewLink(serverId: string | null, workId: string, title: string): Promise<void> {
  if (!serverId) return
  const resource = { kind: 'work', id: workId } as const
  const url = await sharesStore.reviewLink(serverId, resource)
  if (!url) {
    toasts.info('Share this work into your organization first, then copy its review link.')
    void sharesStore.open({ serverId, resource, title })
    return
  }
  try {
    await navigator.clipboard.writeText(url)
    toasts.success('Review link copied', { description: 'Anyone with the link can comment and review.' })
  } catch {
    toasts.error("Couldn't copy the review link")
  }
}

/** What the palette needs from the workspace: the open work, and the commands. */
interface ReviewPaletteSurface {
  worksStore: WorksStore
  openWork(workId: string): void
  router: { panes: readonly PaneEntry[]; focused: PaneEntry }
}

/** The work shown in the focused pane, else in any pane. */
function visibleWorkId(router: ReviewPaletteSurface['router']): string | null {
  for (const pane of [router.focused, ...router.panes]) {
    const ref = visibleRef(pane)
    if (ref?.name === 'work') return ref.params.workId
  }
  return null
}

/**
 * The palette's review commands, the same on every client: review the work on
 * screen, copy its review link, and the works that wait for the reader.
 */
export function workReviewPaletteCommands(surface: ReviewPaletteSurface): Command[] {
  const commands: Command[] = []
  const workId = visibleWorkId(surface.router)
  if (workId) {
    const title = surface.worksStore.get(workId)?.title ?? 'this work'
    commands.push({
      id: 'work-review',
      label: 'Review this work…',
      group: 'Works',
      icon: UserCheck,
      keywords: ['review', 'reviewer', 'approve', 'request changes', 'request review', 'sign off'],
      run: () => openWorkReview(surface, workId),
    }, {
      id: 'work-review-link',
      label: 'Copy review link',
      group: 'Works',
      icon: Link,
      keywords: ['review', 'link', 'guest', 'external', 'share'],
      run: () => void copyWorkReviewLink(surface.worksStore.hostFor(workId), workId, title),
    })
  }
  const inbox = surface.worksStore.reviews.inbox
  if (inbox.length > 0) {
    commands.push({
      id: 'works-needing-my-review',
      label: `Works that need my review (${inbox.length})`,
      group: 'Works',
      icon: UserCheck,
      keywords: ['review', 'inbox', 'requested', 'waiting'],
      children: inbox.map((item) => ({
        id: `work-review:${item.serverId}:${item.workId}`,
        label: item.title,
        group: 'Needs my review',
        hint: item.requestedBy ? `from ${item.requestedBy.displayName}` : undefined,
        run: () => openWorkReview(surface, item.workId),
      })),
    })
  }
  return commands
}
