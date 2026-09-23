import type { PinnedSession } from '@solus/contracts/types'
import type { DraftRow } from '@solus/workspace-ui/components/session/lib/draft-list'
import {
  buildSidebarListItems,
  type SidebarListInput,
  type SidebarListItem,
} from '@solus/workspace-ui/components/session/lib/sidebar-list-items'

/**
 * One entry of the phone's task list. The phone lists the same tasks as the
 * desktop sidebar, in the same one-list shape (docs/plans/sidebar-motion.md,
 * step 3), and leads it with the entries only the phone shows here: labelled
 * drafts, pinned sessions, and who else is on the connected hosts.
 */
export type MobileListItem =
  | Exclude<SidebarListItem, { kind: 'drafts-divider' }>
  | { kind: 'label'; key: string; label: 'Drafts' | 'Pinned' }
  | { kind: 'pin'; key: string; pin: PinnedSession }
  | { kind: 'here-now'; key: string }

export interface MobileListInput extends Omit<SidebarListInput, 'drafts' | 'isSnoozedOpen'> {
  drafts: readonly DraftRow[]
  pinned: readonly PinnedSession[]
  /** False while searching: a search lists tasks only. */
  showsLead: boolean
}

export function buildMobileListItems(input: MobileListInput): MobileListItem[] {
  const lead: MobileListItem[] = []
  if (input.showsLead) {
    if (input.drafts.length > 0) {
      lead.push({ kind: 'label', key: 'label:drafts', label: 'Drafts' })
      for (const draft of input.drafts) lead.push({ kind: 'draft', key: `draft:${draft.draftId}`, draft })
    }
    if (input.pinned.length > 0) {
      lead.push({ kind: 'label', key: 'label:pinned', label: 'Pinned' })
      for (const pin of input.pinned) {
        lead.push({ kind: 'pin', key: `pin:${pin.serverId ?? ''}:${pin.sessionId}`, pin })
      }
    }
    lead.push({ kind: 'here-now', key: 'here-now' })
  }
  // The phone has no control to collapse Snoozed, so it is always open. The
  // desktop's drafts come from the lead above, never from the shared list.
  const tasks = buildSidebarListItems({ ...input, drafts: [], isSnoozedOpen: true })
  return [
    ...lead,
    ...tasks.filter((item): item is Exclude<SidebarListItem, { kind: 'drafts-divider' }> =>
      item.kind !== 'drafts-divider'),
  ]
}
