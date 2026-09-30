import { describe, expect, it } from 'bun:test'
import {
  currentMobileSection,
  hasUnseenSection,
  mobileSectionSignal,
  type MobileSectionSignals,
} from '../../apps/client/src/shell/mobile/lib/mobile-sections'

const QUIET: MobileSectionSignals = { runningTasks: 0, prsNeedingReview: 0, worksNeedingReview: 0 }

describe('the drawer marks the section you are standing in', () => {
  it('resolves a detail route to the list it belongs to', () => {
    // Opening the drawer from one task has to say "Tasks", not nothing: the
    // question the mark answers is which section, never how deep inside it.
    expect(currentMobileSection('task')).toBe('tasks')
    expect(currentMobileSection('prReview')).toBe('prs')
  })

  it('never marks History, which is summoned over a page rather than being one', () => {
    // History has no route to stand on — it is the session picker overlay — so
    // there is no state in which it is the place you are.
    expect(currentMobileSection('chat')).toBeNull()
    expect(currentMobileSection(undefined)).toBeNull()
  })
})

describe('a section row only carries a number worth acting on', () => {
  it('draws nothing when a section is quiet', () => {
    // A zero on every row trains the reader to stop looking at the slot.
    expect(mobileSectionSignal('tasks', QUIET)).toBeNull()
    expect(mobileSectionSignal('prs', QUIET)).toBeNull()
  })

  it('separates motion from attention, so the two never read alike', () => {
    const busy: MobileSectionSignals = { runningTasks: 1, prsNeedingReview: 3, worksNeedingReview: 0 }
    expect(mobileSectionSignal('tasks', busy)).toEqual({ count: 1, tone: 'running' })
    expect(mobileSectionSignal('prs', busy)).toEqual({ count: 3, tone: 'primary' })
  })

  it('carries the works waiting on this reader on Workspace', () => {
    // A review request is a thing to act on, like a pull request to review.
    const asked: MobileSectionSignals = { runningTasks: 0, prsNeedingReview: 0, worksNeedingReview: 2 }
    expect(mobileSectionSignal('workspace', asked)).toEqual({ count: 2, tone: 'primary' })
    expect(hasUnseenSection(asked, 'workspace')).toBe(false)
    expect(hasUnseenSection(asked, 'tasks')).toBe(true)
  })

  it('gives Workspace with no review waiting, History and Settings no signal to carry', () => {
    const busy: MobileSectionSignals = { runningTasks: 1, prsNeedingReview: 3, worksNeedingReview: 0 }
    expect(mobileSectionSignal('workspace', busy)).toBeNull()
    expect(mobileSectionSignal('history', busy)).toBeNull()
    expect(mobileSectionSignal('settings', busy)).toBeNull()
  })
})

describe('the dot on the drawer control means "somewhere you are not looking"', () => {
  it('stays dark while the only signal is in the section already on screen', () => {
    // The three rows waiting for you are visible in the list you are reading.
    // A dot on the control that opens that same list is noise, and a dot that
    // is always lit stops meaning anything.
    expect(hasUnseenSection({ runningTasks: 0, prsNeedingReview: 3, worksNeedingReview: 0 }, 'prs')).toBe(false)
    expect(hasUnseenSection({ runningTasks: 2, prsNeedingReview: 0, worksNeedingReview: 0 }, 'tasks')).toBe(false)
  })

  it('lights when a signal is in some other section', () => {
    expect(hasUnseenSection({ runningTasks: 0, prsNeedingReview: 3, worksNeedingReview: 0 }, 'workspace')).toBe(true)
    expect(hasUnseenSection({ runningTasks: 2, prsNeedingReview: 0, worksNeedingReview: 0 }, 'prs')).toBe(true)
  })

  it('lights for the second signal even while you stand in the first', () => {
    expect(hasUnseenSection({ runningTasks: 1, prsNeedingReview: 3, worksNeedingReview: 0 }, 'tasks')).toBe(true)
  })

  it('stays dark when nothing is happening anywhere', () => {
    expect(hasUnseenSection(QUIET, null)).toBe(false)
  })
})
