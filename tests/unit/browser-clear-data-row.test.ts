import { describe, expect, test } from 'bun:test'
import {
  clearBrowserDataLabel,
  clearedBrowserDataLabel,
  confirmClearBrowserDataLabel,
  isClearBrowserArmed,
  browserProfileProject,
} from '../../packages/workspace-ui/src/components/project-panel/lib/browser-row'

describe('the browser row names the project it would clear', () => {
  test('every label states the project, so the row cannot read as branch-scoped', () => {
    const project = browserProfileProject('/Users/dev/solus')
    expect(project).toBe('solus')
    expect(clearBrowserDataLabel(project)).toContain('solus')
    expect(confirmClearBrowserDataLabel(project)).toContain('solus')
    expect(clearedBrowserDataLabel(project)).toContain('solus')
  })

  test('a worktree checkout still names its project, not the branch directory', () => {
    // Worktrees live beside the project under a generated directory name; the
    // row is handed the repo root, so the name it prints is the project's.
    expect(browserProfileProject('/Users/dev/solus/')).toBe('solus')
  })

  test('an unconfigured working directory has no project to name', () => {
    // The renderer sends `~` before it knows the working directory. Printing
    // "Clear ~'s browser data" would invent a project that does not exist.
    expect(browserProfileProject('~')).toBeNull()
    expect(browserProfileProject(undefined)).toBeNull()
    expect(clearBrowserDataLabel(null)).toBe('Clear browser data')
  })
})

describe('arming to clear does not survive a change of project', () => {
  test('armed for the project the panel still describes', () => {
    expect(isClearBrowserArmed('/Users/dev/solus', '/Users/dev/solus')).toBe(true)
  })

  test('moving to another session disarms rather than retargeting the wipe', () => {
    // The panel retargets when the user switches session. A bare boolean would
    // stay armed across that move and the next click would clear a project the
    // user never pointed at.
    expect(isClearBrowserArmed('/Users/dev/solus', '/Users/dev/other')).toBe(false)
  })

  test('nothing is armed while the panel has no project', () => {
    expect(isClearBrowserArmed(null, '/Users/dev/solus')).toBe(false)
    expect(isClearBrowserArmed('/Users/dev/solus', null)).toBe(false)
  })
})
