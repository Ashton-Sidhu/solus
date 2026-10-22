import { expect, test } from 'bun:test'
import { changeBreakdown, changeBreakdownText, changedFileKind } from '@solus/client-core/change-breakdown'

test('sorts a changed file by its path, first match winning', () => {
  const kinds = {
    'bun.lock': 'generated',
    'packages/contracts/src/generated/codex.ts': 'generated',
    'dist/app.min.js': 'generated',
    // Test support is not a test: a large fixture must not read as test logic.
    'tests/fixtures/session.json': 'mocks',
    'src/__snapshots__/app.test.ts.snap': 'mocks',
    'src/api.mock.ts': 'mocks',
    'tests/unit/app.ts': 'tests',
    'src/app.test.ts': 'tests',
    'internal/app_test.go': 'tests',
    'AppTests.swift': 'tests',
    'docs/plans/plan.md': 'docs',
    'README.md': 'docs',
    // Text that tools read is config, not prose.
    'requirements.txt': 'code',
    // Source names that only look like tests.
    'src/testing.ts': 'code',
    'src/contest.ts': 'code',
    'Latest.java': 'code',
    'AppTest.ts': 'code',
    'src\\__tests__\\app.ts': 'tests',
  } as const
  for (const [path, kind] of Object.entries(kinds)) expect([path, changedFileKind(path)]).toEqual([path, kind])
})

test('splits a change into the kinds it touches, in display order', () => {
  expect(changeBreakdown([
    { path: 'docs/a.md', additions: 4, deletions: 0 },
    { path: 'src/a.ts', additions: 10, deletions: 2 },
    { path: 'src/a.test.ts', additions: 5, deletions: 1 },
    { path: 'src/b.ts', additions: 1, deletions: 1 },
  ])).toEqual([
    { kind: 'code', label: 'Code', additions: 11, deletions: 3 },
    { kind: 'tests', label: 'Tests', additions: 5, deletions: 1 },
    { kind: 'docs', label: 'Docs', additions: 4, deletions: 0 },
  ])
})

test('gives no split when every changed line is one kind', () => {
  expect(changeBreakdown([{ path: 'src/a.ts', additions: 3, deletions: 1 }, { path: 'src/a.test.ts', additions: 0, deletions: 0 }])).toEqual([])
  expect(changeBreakdown([])).toEqual([])
})

test('gives no split when the files do not add up to the total shown beside it', () => {
  const files = [{ path: 'src/a.ts', additions: 10, deletions: 2 }, { path: 'src/a.test.ts', additions: 5, deletions: 1 }]
  expect(changeBreakdown(files, { additions: 15, deletions: 3 })).toHaveLength(2)
  // The host stopped reading files before the end of the change.
  expect(changeBreakdown(files, { additions: 900, deletions: 3 })).toEqual([])
})

test('writes the split as one line', () => {
  expect(changeBreakdownText(changeBreakdown([
    { path: 'src/a.ts', additions: 1200, deletions: 30 },
    { path: 'README.md', additions: 4, deletions: 0 },
  ]))).toBe('Code +1,200 −30 · Docs +4 −0')
})

test('draws each kind against the largest one, and a tiny kind still shows', async () => {
  const { churnShares } = await import('../../packages/workspace-ui/src/components/ui/change-breakdown/change-breakdown')
  const parts = changeBreakdown([
    { path: 'src/a.ts', additions: 800, deletions: 200 },
    { path: 'src/a.test.ts', additions: 400, deletions: 100 },
    { path: 'bun.lock', additions: 1, deletions: 0 },
  ])
  expect(churnShares(parts)).toEqual([100, 50, 4])
})
