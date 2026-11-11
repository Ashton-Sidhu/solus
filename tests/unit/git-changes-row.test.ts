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

test('uncommitted lines are what the row counts, so a commit changes it', () => {
  const row = changesRow(status({
    uncommittedFileCount: 2,
    uncommittedTotals: { fileCount: 2, insertions: 3, deletions: 1 },
    branchChanges: { fileCount: 5, insertions: 40, deletions: 9 },
  }))
  expect(row.label).toBe('Changes')
  expect(row.lines).toEqual({ fileCount: 2, insertions: 3, deletions: 1 })
  expect(row.fileCount).toBe(2)
})

test('after a commit on a branch, the row names the target its count is against', () => {
  const row = changesRow(status({
    uncommittedFileCount: 0,
    // The details can lag the summary scan: these are from before the commit.
    uncommittedTotals: { fileCount: 2, insertions: 3, deletions: 1 },
    branchChanges: { fileCount: 5, insertions: 40, deletions: 9 },
  }))
  expect(row.label).toBe('Changes vs main')
  expect(row.lines).toEqual({ fileCount: 5, insertions: 40, deletions: 9 })
})

test('a clean target branch reports no changes', () => {
  const row = changesRow(status({
    branch: 'main',
    branchChanges: { fileCount: 0, insertions: 0, deletions: 0 },
  }))
  expect(row).toEqual({ label: 'Changes', fileCount: 0, tooltip: 'No changes' })
})

test('on the target branch, a host without uncommitted totals still gives line counts', () => {
  const row = changesRow(status({
    branch: 'main',
    uncommittedFileCount: 2,
    branchChanges: { fileCount: 2, insertions: 7, deletions: 1 },
  }))
  expect(row.lines).toEqual({ fileCount: 2, insertions: 7, deletions: 1 })
})
