import { describe, expect, test } from 'bun:test'
import { parseChangedFileStats } from '@solus/server/git/session-snapshots'
import {
  NESTED_ROWS,
  buildDiffSummaryTree,
  changeRatio,
  flattenDiffTree,
} from '@solus/workspace-ui/components/conversation/lib/diff-summary-tree'

const ALL = new Set<string>()

describe('changed-file status', () => {
  // The summary block is the only thing in the numstat output that distinguishes
  // a new file from an edited one — without it every row would read as "M" and
  // the status slot would carry no information at all.
  test('the summary block promotes created, deleted and renamed files off the default M', () => {
    const stats = parseChangedFileStats(
      [
        '4\t0\tsrc/new.ts',
        '0\t9\tsrc/gone.ts',
        '2\t2\tsrc/edited.ts',
        '1\t1\tsrc/{old.ts => moved.ts}',
        ' create mode 100644 src/new.ts',
        ' delete mode 100644 src/gone.ts',
        ' rename src/{old.ts => moved.ts} (94%)',
      ].join('\n'),
    )

    expect(stats).toEqual([
      { path: 'src/new.ts', additions: 4, deletions: 0, status: 'A' },
      { path: 'src/gone.ts', additions: 0, deletions: 9, status: 'D' },
      { path: 'src/edited.ts', additions: 2, deletions: 2, status: 'M' },
      { path: 'src/moved.ts', additions: 1, deletions: 1, status: 'R' },
    ])
  })

  test('a binary file still counts as a row because it changed, even with no line counts', () => {
    const stats = parseChangedFileStats('-\t-\tassets/logo.png\n create mode 100644 assets/logo.png')
    expect(stats).toEqual([{ path: 'assets/logo.png', additions: 0, deletions: 0, status: 'A' }])
  })
})

describe('diff summary tree', () => {
  test('a single-child folder chain compresses, so depth never costs a row it cannot justify', () => {
    const tree = buildDiffSummaryTree(['src/renderer/components/a.ts', 'src/renderer/components/b.ts'], [])
    expect(tree.root.folders).toHaveLength(1)
    expect(tree.root.folders[0].label).toBe('src/renderer/components')
    expect(tree.root.folders[0].path).toBe('src/renderer/components')
  })

  test('a chain branches at the folder the change actually forks in', () => {
    const tree = buildDiffSummaryTree(['src/main/git/a.ts', 'src/renderer/lib/b.ts'], [])
    expect(tree.root.folders.map((folder) => folder.label)).toEqual(['src/main/git', 'src/renderer/lib'])
  })

  test('counts roll up the tree so a folder row answers for everything under it', () => {
    const tree = buildDiffSummaryTree(undefined, [
      { path: 'src/a/one.ts', additions: 10, deletions: 1, status: 'M' },
      { path: 'src/b/two.ts', additions: 5, deletions: 4, status: 'A' },
    ])
    expect(tree.additions).toBe(15)
    expect(tree.deletions).toBe(5)
    expect(tree.total).toBe(2)
    expect(tree.root.folders.map((folder) => folder.label)).toEqual(['src/a', 'src/b'])
    expect(tree.root.folders[0]).toMatchObject({ fileCount: 1, additions: 10, deletions: 1 })
  })

  test('a lone top branch is lifted away, so no row exists that everything sits under', () => {
    const tree = buildDiffSummaryTree(['src/a/one.ts', 'src/b/two.ts'], [])
    expect(tree.root.folders.map((folder) => folder.label)).toEqual(['src/a', 'src/b'])
  })

  test('paths without counts still render, because git answers after the transcript does', () => {
    const tree = buildDiffSummaryTree(['src/a.ts'], [])
    expect(tree.root.folders[0].files[0]).toMatchObject({ additions: 0, deletions: 0, status: 'M' })
  })

  test('a turn summary with no path list of its own reads its paths from the stats', () => {
    const tree = buildDiffSummaryTree(undefined, [
      { path: 'src/a.ts', additions: 7, deletions: 2, status: 'A' },
    ])
    expect(tree.total).toBe(1)
    expect(tree.root.folders[0].files[0]).toMatchObject({ name: 'a.ts', status: 'A' })
  })
})

describe('opening the tree', () => {
  const paths = (count: number, folder: string): string[] =>
    Array.from({ length: count }, (_, i) => `${folder}/file${i}.ts`)

  // Nothing opens itself: the card and every folder in it start closed, so a
  // 360-file sweep and a two-file edit both arrive the same height.
  test('a closed tree shows one row per top-level folder, whatever it holds', () => {
    const wide = Array.from({ length: 12 }, (_, i) => paths(30, `src/dir${i}`)).flat()
    const tree = buildDiffSummaryTree(wide, [])
    expect(flattenDiffTree(tree, new Set(), ALL)).toHaveLength(12)
    expect(tree.total).toBe(360)
  })

  test('opening a folder reveals only that folder, not the branch under it', () => {
    const tree = buildDiffSummaryTree(['src/a/deep/one.ts', 'src/b/two.ts'], [])
    const rows = flattenDiffTree(tree, new Set(['src/a/deep']), new Set())
    expect(rows.filter((row) => row.kind === 'file')).toHaveLength(1)
  })

  test('a folder with more files than fit keeps the tail behind its own show-more row', () => {
    const tree = buildDiffSummaryTree(paths(NESTED_ROWS + 4, 'src/a'), [])
    const rows = flattenDiffTree(tree, new Set(['src/a']), new Set())
    expect(rows.filter((row) => row.kind === 'file')).toHaveLength(NESTED_ROWS)
    expect(rows.at(-1)).toMatchObject({ kind: 'more', hidden: 4 })
  })

  test('asking for the rest of a folder drops its show-more row', () => {
    const tree = buildDiffSummaryTree(paths(NESTED_ROWS + 4, 'src/a'), [])
    const rows = flattenDiffTree(tree, new Set(['src/a']), new Set(['src/a']))
    expect(rows.filter((row) => row.kind === 'file')).toHaveLength(NESTED_ROWS + 4)
    expect(rows.some((row) => row.kind === 'more')).toBe(false)
  })

  test('a collapsed folder contributes exactly one row, whatever it holds', () => {
    const tree = buildDiffSummaryTree(paths(50, 'src/a'), [])
    expect(flattenDiffTree(tree, new Set(), new Set())).toHaveLength(1)
  })

  test('a folder bar with no counted lines draws nothing rather than a full bar', () => {
    expect(changeRatio({ additions: 0, deletions: 0 })).toEqual({ added: 0, removed: 0 })
  })
})
