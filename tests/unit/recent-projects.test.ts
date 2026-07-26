import { describe, expect, test } from 'bun:test'
import { alsoOnLabel, recentProjectRows } from '../../src/renderer/components/layout/lib/recent-projects'
import { canonicalRecentProjects } from '../../src/shared/recent-projects'

const SOLUS = 'github.com/solus-sh/solus'

const recents = [
  { path: '/home/dev/projects/solus', folderName: 'solus', lastOpened: '2026-07-25T10:00:00Z' },
  { path: '/home/dev/projects/solus/.solus/wt/fix', folderName: 'fix', lastOpened: '2026-07-25T09:00:00Z' },
  { path: '/home/dev/notes', folderName: 'notes', lastOpened: '2026-07-24T09:00:00Z' },
]

const identities = [
  { path: '/home/dev/projects/solus', folderName: 'solus', repoKey: SOLUS },
  { path: '/home/dev/projects/solus/.solus/wt/fix', folderName: 'fix', repoKey: SOLUS },
]

describe('recent project paths', () => {
  test('a worktree is represented by its actual project root', () => {
    // WHY: Cmd+Shift+O opens projects, so a session worktree must never appear
    // there as if it were a standalone project.
    expect(canonicalRecentProjects([
      {
        path: '/home/dev/projects/solus/.solus-worktrees/fix-open-projects',
        folderName: 'fix-open-projects',
        lastOpened: '2026-07-25T11:00:00Z',
      },
    ])).toEqual([
      {
        path: '/home/dev/projects/solus',
        folderName: 'solus',
        lastOpened: '2026-07-25T11:00:00Z',
      },
    ])
  })

  test('a newer worktree and its project consume one recent-project slot', () => {
    // WHY: legacy databases can contain both paths; preserving the first row
    // keeps the newest timestamp while removing the duplicate project.
    expect(canonicalRecentProjects([
      {
        path: '/home/dev/projects/solus/.solus-worktrees/fix-open-projects',
        folderName: 'fix-open-projects',
        lastOpened: '2026-07-25T11:00:00Z',
      },
      recents[0],
      recents[2],
    ])).toEqual([
      {
        path: '/home/dev/projects/solus',
        folderName: 'solus',
        lastOpened: '2026-07-25T11:00:00Z',
      },
      recents[2],
    ])
  })
})

describe('recent project rows', () => {
  test('two checkouts of one repository take one slot, not two', () => {
    // WHY: the list is three rows long. A base checkout and its session worktree
    // eating two of them hides a project the user actually has.
    const rows = recentProjectRows({ recents, identities, otherHosts: [], limit: 3 })
    expect(rows.map((row) => row.path)).toEqual(['/home/dev/projects/solus', '/home/dev/notes'])
  })

  test('the most recent checkout is the one that keeps the slot', () => {
    const rows = recentProjectRows({
      recents: [recents[1], recents[0], recents[2]],
      identities,
      otherHosts: [],
      limit: 3,
    })
    expect(rows[0].path).toBe('/home/dev/projects/solus/.solus/wt/fix')
  })

  test('a folder with no origin is not merged with anything', () => {
    // WHY: no remote means no repo key — two unrelated plain folders must not
    // collapse into each other just because neither could name a repository.
    const rows = recentProjectRows({
      recents: [recents[2], { ...recents[2], path: '/home/dev/scratch', folderName: 'scratch' }],
      identities: [],
      otherHosts: [],
      limit: 3,
    })
    expect(rows).toHaveLength(2)
  })

  test('a row names the other hosts holding the same repository', () => {
    // WHY: the same repo checked out on two hosts used to render as two
    // identical rows with nothing to tell them apart.
    const rows = recentProjectRows({
      recents,
      identities,
      otherHosts: [
        { id: 'studio', label: 'Studio', identities: [{ path: '/srv/solus', folderName: 'solus', repoKey: SOLUS.toUpperCase() }] },
        { id: 'bench', label: 'Bench', identities: [] },
      ],
      limit: 3,
    })
    expect(rows[0].alsoOn).toEqual([{ id: 'studio', label: 'Studio' }])
    expect(rows[1].alsoOn).toEqual([])
  })

  test('more than two hosts are counted rather than listed', () => {
    // WHY: a 200px row can print two names; five is a list nobody reads.
    expect(alsoOnLabel([{ label: 'Studio' }, { label: 'Bench' }])).toBe('Also on Studio, Bench')
    expect(alsoOnLabel([{ label: 'A' }, { label: 'B' }, { label: 'C' }])).toBe('Also on 3 hosts')
  })
})
