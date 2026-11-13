import { expect, test } from 'bun:test'
import type { GitState } from '@solus/contracts/types'
import { changesRow } from '@solus/workspace-ui/components/project-panel/lib/changes-row'

function status(fields: Partial<GitState> & { uncommittedFileCount?: number }): GitState {
  const { uncommittedFileCount = 0, ...rest } = fields
  return {
    repoRoot: '/repo',
    headSha: 'abc',
    branch: 'feature',
    targetBranch: 'main',
    upstreamRef: null,
    aheadCount: 0,
    behindCount: 0,
    uncommittedChanges: { files: [], hasMoreFiles: false, fileCount: uncommittedFileCount, mergeInProgress: false },
    ...rest,
  }
}

test('a dirty feature branch counts committed and uncommitted work against its target', () => {
  const row = changesRow(status({
    uncommittedFileCount: 2,
    uncommittedTotals: { fileCount: 2, insertions: 3, deletions: 1 },
    branchChanges: { fileCount: 5, insertions: 40, deletions: 9 },
  }))
  expect(row.label).toBe('Changes vs main')
  expect(row.lines).toEqual({ fileCount: 5, insertions: 40, deletions: 9 })
  expect(row.fileCount).toBe(5)
  expect(row.tooltip).toContain('including uncommitted work')
})

test('a commit does not change the feature branch comparison', () => {
  const before = status({
    uncommittedFileCount: 2,
    uncommittedTotals: { fileCount: 2, insertions: 3, deletions: 1 },
    branchChanges: { fileCount: 5, insertions: 40, deletions: 9 },
  })
  // The details can lag the summary scan after the commit.
  const after = status({
    ...before,
    uncommittedChanges: { ...before.uncommittedChanges, fileCount: 0 },
  })
  expect(changesRow(after)).toEqual(changesRow(before))
})

test('a branch waits for its totals instead of showing a different comparison', () => {
  const row = changesRow(status({
    uncommittedFileCount: 2,
    uncommittedTotals: { fileCount: 2, insertions: 3, deletions: 1 },
  }))
  expect(row.label).toBe('Changes vs main')
  expect(row.lines).toBeUndefined()
  expect(row.fileCount).toBe(0)
})

test('uncommitted work that undoes the branch change keeps the zero branch total', () => {
  const row = changesRow(status({
    uncommittedFileCount: 1,
    uncommittedTotals: { fileCount: 1, insertions: 0, deletions: 7 },
    branchChanges: { fileCount: 0, insertions: 0, deletions: 0 },
  }))
  expect(row.lines).toEqual({ fileCount: 0, insertions: 0, deletions: 0 })
  expect(row.fileCount).toBe(0)
})

test('a clean target branch hides stale details after a commit', () => {
  const row = changesRow(status({
    branch: 'main',
    branchChanges: { fileCount: 2, insertions: 7, deletions: 1 },
    uncommittedTotals: { fileCount: 2, insertions: 7, deletions: 1 },
  }))
  expect(row).toEqual({ label: 'Changes', fileCount: 0, tooltip: 'No changes' })
})

test('the target branch counts uncommitted work', () => {
  const row = changesRow(status({
    branch: 'main',
    uncommittedFileCount: 2,
    uncommittedTotals: { fileCount: 2, insertions: 7, deletions: 1 },
  }))
  expect(row.lines).toEqual({ fileCount: 2, insertions: 7, deletions: 1 })
  expect(row.fileCount).toBe(2)
})

test('on the target branch, an older host still gives line counts', () => {
  const row = changesRow(status({
    branch: 'main',
    uncommittedFileCount: 2,
    branchChanges: { fileCount: 2, insertions: 7, deletions: 1 },
  }))
  expect(row.lines).toEqual({ fileCount: 2, insertions: 7, deletions: 1 })
})

test('the target branch shows a file count while line totals load', () => {
  const row = changesRow(status({ branch: 'main', uncommittedFileCount: 2 }))
  expect(row.lines).toBeUndefined()
  expect(row.fileCount).toBe(2)
})

test('unavailable status does not invent counts', () => {
  expect(changesRow(null)).toEqual({ label: 'Changes', fileCount: 0 })
  expect(changesRow(undefined)).toEqual(changesRow(null))
})
