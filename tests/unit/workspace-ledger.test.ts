import { describe, expect, it } from 'bun:test'
import type { Work } from '@solus/contracts/types'
import {
  DEFAULT_FILTER,
  applyFilter,
  buildWorkspaceItems,
  formatGeneratedDate,
  formatGeneratedFull,
  groupItems,
  isDefaultFilter,
  isHtmlArtifact,
  parseToken,
  projectOptions,
  sortItems,
  upstreamProviderFor,
  workItem,
  type WorkspaceItem,
  type WorkspaceProject,
} from '@solus/workspace-ui/components/workspace/lib/workspace-items'
import { highlightRuns } from '@solus/workspace-ui/lib/searchHighlight'

const DAY = 86_400_000

function item(over: Partial<WorkspaceItem> & { id: string; timestamp: number }): WorkspaceItem {
  return {
    rowKey: `test:${over.id}`,
    type: 'doc',
    glyph: 'doc',
    title: over.id,
    snippet: '',
    createdAt: 0,
    sessionId: null,
    pinned: false,
    pinnedAt: over.timestamp,
    cwd: '/repo',
    projectKey: '/repo',
    projectLabel: 'repo',
    reviewState: null,
    reviewers: [],
    awaitingMyReview: false,
    work: {} as never,
    ...over,
  }
}

describe('the ledger orders and groups what the reader asked for', () => {
  it('moves a pinned item into Pinned instead of copying it, so no title is on the page twice', () => {
    const items = [
      item({ id: 'pinned', timestamp: Date.now(), pinned: true }),
      item({ id: 'loose', timestamp: Date.now() }),
    ]
    const { pinned, groups } = groupItems(items)
    expect(pinned.map((i) => i.id)).toEqual(['pinned'])
    expect(groups.flatMap((g) => g.items.map((i) => i.id))).toEqual(['loose'])
  })

  it('reverses the date buckets under oldest-first — a reader asking for the oldest work sees it first', () => {
    const items = [
      item({ id: 'now', timestamp: Date.now() }),
      item({ id: 'old', timestamp: Date.now() - 40 * DAY }),
    ]
    const recent = groupItems(sortItems(items, 'recent')).groups.map((g) => g.items[0].id)
    const oldest = groupItems(sortItems(items, 'oldest')).groups.map((g) => g.items[0].id)
    expect(recent).toEqual(['now', 'old'])
    expect(oldest).toEqual(['old', 'now'])
  })
})

describe('the Workspace is global', () => {
  const KNOWN: WorkspaceProject = { key: '/known', label: 'known', roots: ['/known'] }
  const work = (id: string, cwd: string) =>
    ({ id, type: 'doc', title: id, preview: '', createdAt: '', updatedAt: '', cwd }) as Work

  it('shows works from every project, not only the one in focus', () => {
    const other: WorkspaceProject = { key: '/other', label: 'other', roots: ['/other'] }
    const built = buildWorkspaceItems([work('a', '/known/sub'), work('b', '/other')], [KNOWN, other])
    expect(built.map((entry) => [entry.id, entry.projectLabel])).toEqual([
      ['a', 'known'],
      ['b', 'other'],
    ])
  })

  it('keeps a work that no known project claims, filed under its own folder', () => {
    const [built] = buildWorkspaceItems([work('stray', '/elsewhere/notes/')], [KNOWN])
    expect(built.projectKey).toBe('/elsewhere/notes/')
    expect(built.projectLabel).toBe('notes')
  })
})

describe('project is one filter among the others', () => {
  const items = [
    item({ id: 'a1', timestamp: 3, projectKey: '/a', projectLabel: 'alpha' }),
    item({ id: 'b1', timestamp: 2, projectKey: '/b', projectLabel: 'beta' }),
    item({ id: 'a2', timestamp: 1, projectKey: '/a', projectLabel: 'alpha' }),
  ]

  it('shows every project until the reader picks one', () => {
    expect(applyFilter(items, DEFAULT_FILTER)).toHaveLength(3)
    expect(applyFilter(items, { ...DEFAULT_FILTER, project: '/a' }).map((i) => i.id)).toEqual(['a1', 'a2'])
  })

  it('counts as an active filter, so the ledger reads as filtered', () => {
    expect(isDefaultFilter({ ...DEFAULT_FILTER, project: '/a' })).toBe(false)
  })

  it('offers only the projects that hold a work, by name, with their counts', () => {
    expect(projectOptions(items)).toEqual([
      { value: '/a', label: 'alpha', count: 2 },
      { value: '/b', label: 'beta', count: 1 },
    ])
  })
})

describe('HTML artifact mobile behavior', () => {
  it('identifies only rendered HTML works so mobile can skip the source-text peek', () => {
    const artifact = workItem(
      { id: 'artifact', type: 'artifact', updatedAt: '', cwd: '/repo' } as Work,
      { key: '/repo', label: 'repo', roots: ['/repo'] },
    )
    const document = workItem(
      { id: 'doc', type: 'doc', updatedAt: '', cwd: '/repo' } as Work,
      { key: '/repo', label: 'repo', roots: ['/repo'] },
    )

    expect(isHtmlArtifact(artifact)).toBe(true)
    expect(isHtmlArtifact(document)).toBe(false)
  })
})

describe('a row is marked with what actually made it', () => {
  const PROJECT: WorkspaceProject = { key: '/repo', label: 'repo', roots: ['/repo'] }
  const work = (type: string) =>
    workItem({ id: 'w', type, updatedAt: '2026-01-01T00:00:00Z', cwd: '/repo' } as Work, PROJECT).glyph

  it('keeps each work format on the icon Solus already uses for it, slides included', () => {
    expect(work('doc')).toBe('doc')
    expect(work('slides')).toBe('slides')
    expect(work('diagram')).toBe('diagram')
  })

  it('gives HTML artifacts their own facet instead of filing them under Docs', () => {
    expect(workItem({ id: 'w', type: 'artifact', updatedAt: '', cwd: '/repo' } as Work, PROJECT).type).toBe(
      'artifact',
    )
    expect(parseToken('type:artifact')).toEqual({ type: 'artifact' })
  })

  it('still files slides under the Docs facet, so the rail count stays honest', () => {
    expect(workItem({ id: 'w', type: 'slides', updatedAt: '', cwd: '/repo' } as Work, PROJECT).type).toBe(
      'doc',
    )
  })

  it('shows only linked works in the upstream-provider column', () => {
    const linked = workItem(
      {
        id: 'linked',
        type: 'doc',
        updatedAt: '',
        cwd: '/repo',
        mirroredDoc: { provider: 'gdrive' },
      } as Work,
      PROJECT,
    )
    const local = workItem({ id: 'local', type: 'doc', updatedAt: '', cwd: '/repo' } as Work, PROJECT)

    expect(upstreamProviderFor(linked)).toBe('gdrive')
    expect(upstreamProviderFor(local)).toBeNull()
  })
})

describe('a row carries the provenance the peek does not', () => {
  const PROJECT: WorkspaceProject = { key: '/repo', label: 'repo', roots: ['/repo'] }

  it('links a work back to its newest collaborator, not the session that opened it', () => {
    const built = workItem(
      {
        id: 'w',
        type: 'doc',
        createdAt: '2026-07-01T09:00:00Z',
        updatedAt: '2026-07-04T09:00:00Z',
        sessionId: 'first',
        sessionIds: ['first', 'second', 'third'],
        cwd: '/repo',
      } as Work,
      PROJECT,
    )
    expect(built.sessionId).toBe('third')
    // Created and last-touched are separate facts on a work, and the row shows
    // both — collapsing them would make an edited doc look freshly generated.
    expect(built.createdAt).toBe(Date.parse('2026-07-01T09:00:00Z'))
    expect(built.timestamp).toBe(Date.parse('2026-07-04T09:00:00Z'))
  })

  it('falls back to the legacy single session id on works written before the list existed', () => {
    const built = workItem(
      { id: 'w', type: 'doc', createdAt: '', updatedAt: '', sessionId: 'only', cwd: '/repo' } as Work,
      PROJECT,
    )
    expect(built.sessionId).toBe('only')
  })

  it('leaves a hand-made work without a session rather than inventing one', () => {
    const built = workItem({ id: 'w', type: 'doc', createdAt: '', updatedAt: '', cwd: '/repo' } as Work, PROJECT)
    expect(built.sessionId).toBeNull()
  })
})

describe('the generated column', () => {
  const now = new Date('2026-08-05T12:00:00Z')

  it('drops the year while it is still this one, and names it once it is not', () => {
    expect(formatGeneratedDate(new Date('2026-07-15T12:00:00').getTime(), now)).toBe('Jul 15')
    expect(formatGeneratedDate(new Date('2025-07-15T12:00:00').getTime(), now)).toBe('Jul 15, 2025')
  })

  it('stays empty rather than printing the epoch for a work with no date on it', () => {
    expect(formatGeneratedDate(0, now)).toBe('')
    expect(formatGeneratedFull(0)).toBe('')
  })
})

describe('search highlighting marks what matched', () => {
  it('splits every case-insensitive occurrence, keeping the original casing', () => {
    expect(highlightRuns('Session Sidebar', 'sidebar')).toEqual([
      { text: 'Session ', hit: false },
      { text: 'Sidebar', hit: true },
    ])
  })

  it('returns one plain run when nothing is being searched, so rows need no branch', () => {
    expect(highlightRuns('Session Sidebar', '  ')).toEqual([
      { text: 'Session Sidebar', hit: false },
    ])
  })
})
