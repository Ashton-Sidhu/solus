/**
 * The five destinations the mobile drawer's section row carries, and the
 * signals that decide whether one of them is worth a tap.
 *
 * The phone has no persistent tab bar — 852px of height is too little to spend
 * 56 of it on chrome that is one tap away — so this row inside the drawer is
 * the whole navigation surface, alongside the two cards on the home screen.
 * Nothing here was invented for it: Workspace, Tasks and Pull requests are the
 * routed pages `page-nav.ts` already names, History summons the session picker
 * overlay, and Settings is the settings route.
 *
 * Only the decisions live here. The labels, the glyphs and the commands stay in
 * the drawer, because those are markup and navigation rather than rules.
 */

export type MobileSectionId = 'workspace' | 'tasks' | 'prs' | 'history' | 'settings'

/** What the drawer knows about the sections the reader is not looking at. */
export interface MobileSectionSignals {
  /** Sessions running right now, across every task. */
  runningTasks: number
  /** Pull requests waiting on this reader specifically. */
  prsNeedingReview: number
}

/** A count a section row carries, and whether it reads as motion or as
 *  attention. Absent when the section has nothing to report — a zero is not a
 *  signal, and drawing one trains the reader to ignore the slot. */
export interface MobileSectionSignal {
  count: number
  tone: 'running' | 'primary'
}

/**
 * Which section the reader is standing in, so the drawer can mark it.
 *
 * The detail routes resolve to their list — a task is inside Tasks and a review
 * is inside Pull requests — because "where am I" is answered by the section,
 * not by the depth. History is deliberately absent: it is an overlay summoned
 * over whatever is on screen, so it is never the place you are.
 */
export function currentMobileSection(routeName: string | null | undefined): MobileSectionId | null {
  switch (routeName) {
    case 'folio':
      return 'workspace'
    case 'tasks':
    case 'task':
      return 'tasks'
    case 'prs':
    case 'prReview':
      return 'prs'
    case 'settings':
      return 'settings'
    default:
      return null
  }
}

/** The signal one section carries, or null when it has nothing to say. */
export function mobileSectionSignal(
  id: MobileSectionId,
  signals: MobileSectionSignals,
): MobileSectionSignal | null {
  if (id === 'tasks' && signals.runningTasks > 0) {
    return { count: signals.runningTasks, tone: 'running' }
  }
  if (id === 'prs' && signals.prsNeedingReview > 0) {
    return { count: signals.prsNeedingReview, tone: 'primary' }
  }
  return null
}

/**
 * Whether the drawer control deserves its dot: something is happening in a
 * section other than the one on screen.
 *
 * Scoped to *other* sections on purpose. A reader already looking at the PR
 * list can see the three rows waiting for them; repeating that as a dot on the
 * control which opens the list they are reading is noise, and a dot that is
 * always lit stops meaning anything.
 */
export function hasUnseenSection(
  signals: MobileSectionSignals,
  current: MobileSectionId | null,
): boolean {
  if (signals.runningTasks > 0 && current !== 'tasks') return true
  if (signals.prsNeedingReview > 0 && current !== 'prs') return true
  return false
}
