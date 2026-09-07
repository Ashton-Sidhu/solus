
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

export function hasUnseenSection(
  signals: MobileSectionSignals,
  current: MobileSectionId | null,
): boolean {
  if (signals.runningTasks > 0 && current !== 'tasks') return true
  if (signals.prsNeedingReview > 0 && current !== 'prs') return true
  return false
}
