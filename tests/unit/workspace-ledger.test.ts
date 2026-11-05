import { describe, expect, it } from 'bun:test'
import type { Work } from '@solus/contracts/types'
import {
  DEFAULT_FILTER,
  applyFilter,
  applySessionFilter,
  buildSharedSessionItems,
  buildWorkspaceItems,
  groupSharedSessions,
  groupSharedWorks,
  isSharedWithMe,
  roleLabel,
  shareStateLabel,
  splitByOwnership,
  workspaceTabs,
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
  type WorkspaceProjects,
} from '@solus/workspace-ui/components/workspace/lib/workspace-items'
import type { ListedSession } from '@solus/workspace-ui/contexts/workspace/session-list.store.svelte'
import { projectOptionsFor, type LogicalProject } from '@solus/workspace-ui/contexts/projects/project-catalog'
import { localProjectKey } from '@solus/contracts/repository-key'
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
    role: null,
    ownerKey: null,
    share: null,
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
  // The catalog as the page reads it: a work belongs to the project its host
  // and folder name, and rows take the names the shared row builder gives.
  const checkout = (serverId: string, projectRoot: string, repositoryKey: string | null) =>
    ({ serverId, projectRoot, label: projectRoot.split('/').at(-1)!, lastSeenAt: 1, repositoryKey })
  const catalog: LogicalProject[] = [
    { key: 'github.com/acme/web', label: 'web', cloudProject: null, checkouts: [checkout('laptop', '/code/web', 'github.com/acme/web'), checkout('studio', '/srv/web', 'github.com/acme/web')] },
    { key: 'github.com/other/web', label: 'web', cloudProject: null, checkouts: [checkout('laptop', '/forks/web', 'github.com/other/web')] },
  ]
  const hostOf = new Map<string, string>()
  const projects: WorkspaceProjects = {
    keyOf: (w) => {
      const serverId = hostOf.get(w.id)!
      const entry = catalog.flatMap((project) => project.checkouts).find((c) => c.serverId === serverId && w.cwd.startsWith(c.projectRoot))
      return entry?.repositoryKey ?? localProjectKey(serverId, w.cwd)
    },
    optionsFor: (keys) => projectOptionsFor(keys, catalog, () => true, null),
  }
  const work = (id: string, serverId: string, cwd: string) => {
    hostOf.set(id, serverId)
    return { id, type: 'doc', title: id, preview: '', createdAt: '', updatedAt: '', cwd } as Work
  }

  it('files works from every checkout of one repository, on any host, under one project', () => {
    // WHY: one repository on two machines is one project. The filter must not
    // offer it twice, and choosing it must show the works from both.
    const built = buildWorkspaceItems([work('a', 'laptop', '/code/web'), work('b', 'studio', '/srv/web')], projects)
    expect(new Set(built.map((entry) => entry.projectKey))).toEqual(new Set(['github.com/acme/web']))
    expect(projectOptions(built)).toEqual([{ value: 'github.com/acme/web', label: 'web', count: 2 }])
  })

  it('keeps two repositories with one name as two rows, each named plainly', () => {
    const built = buildWorkspaceItems([work('a', 'laptop', '/code/web'), work('b', 'laptop', '/forks/web')], projects)
    expect(projectOptions(built).map((option) => [option.value, option.label])).toEqual([['github.com/acme/web', 'web'], ['github.com/other/web', 'web']])
    expect(built.map((entry) => entry.projectLabel)).toEqual(['web', 'web'])
  })

  it('never joins the same path on two hosts when no repository joins them', () => {
    const built = buildWorkspaceItems([work('a', 'laptop', '/notes'), work('b', 'studio', '/notes')], projects)
    expect(projectOptions(built).map((option) => [option.value, option.label])).toEqual([[localProjectKey('laptop', '/notes'), 'notes'], [localProjectKey('studio', '/notes'), 'notes']])
  })

  it('keeps a work that no known project claims, filed under its own folder', () => {
    const [built] = buildWorkspaceItems([work('stray', 'laptop', '/elsewhere/notes')], projects)
    expect(built.projectKey).toBe(localProjectKey('laptop', '/elsewhere/notes'))
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

// ─── The three groups (docs/workspace-page.md) ───

function listed(over: Partial<ListedSession> & { sessionId: string }): ListedSession {
  return {
    serverId: 'host',
    homeServerId: 'host',
    runnerOffline: false,
    title: over.sessionId,
    projectPath: '/Users/ada/acme/solus',
    createdAt: 1,
    lastActivityAt: Date.now(),
    status: 'idle',
    branch: null,
    ownerKey: 'account:ada',
    opensWith: { provider: 'claude-code', projectPath: '-repo', cwd: '/repo' },
    ...over,
  }
}

describe('a record is shared with the reader when its host answered a role below owner', () => {
  it('counts a viewer, a commenter, an editor and a custom role as shared, and nothing else', () => {
    expect(isSharedWithMe('viewer')).toBe(true)
    expect(isSharedWithMe('commenter')).toBe(true)
    expect(isSharedWithMe('editor')).toBe(true)
    expect(isSharedWithMe('custom')).toBe(true)
    // The reader's own: the owner, or a record on a host that is theirs, which carries no role.
    expect(isSharedWithMe('owner')).toBe(false)
    expect(isSharedWithMe(null)).toBe(false)
    expect(isSharedWithMe(undefined)).toBe(false)
    // A record the reader cannot open is never listed, and is not "shared".
    expect(isSharedWithMe('none')).toBe(false)
  })

  it('splits the ledger into the reader\'s own works and the ones shared with them', () => {
    const items = [
      item({ id: 'mine', timestamp: 3 }),
      item({ id: 'owned', timestamp: 2, role: 'owner' }),
      item({ id: 'theirs', timestamp: 1, role: 'editor' }),
    ]
    const { yours, shared } = splitByOwnership(items)
    expect(yours.map((i) => i.id)).toEqual(['mine', 'owned'])
    expect(shared.map((i) => i.id)).toEqual(['theirs'])
  })

  it('names the tabs with their counts, in the order the page draws them', () => {
    expect(workspaceTabs({ yours: 3, 'shared-works': 1, 'shared-sessions': 0 }).map((tab) => [tab.id, tab.count])).toEqual([
      ['yours', 3],
      ['shared-works', 1],
      ['shared-sessions', 0],
    ])
  })

  it('names a role the way the share dialog does', () => {
    expect(roleLabel('editor')).toBe('Can edit')
    expect(roleLabel('commenter')).toBe('Can comment')
    expect(roleLabel('viewer')).toBe('Can view')
    expect(roleLabel('custom')).toBe('Custom')
  })
})

describe('shared works lead with what needs the reader', () => {
  it('lifts a work awaiting the reader\'s review above the date buckets, whatever its age', () => {
    const now = Date.now()
    const groups = groupSharedWorks([
      item({ id: 'fresh', timestamp: now, role: 'viewer' }),
      item({ id: 'old-review', timestamp: now - 40 * DAY, role: 'viewer', awaitingMyReview: true }),
    ])
    expect(groups[0]!.label).toBe('Needs you')
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['old-review'])
    expect(groups[1]!.label).toBe('Today')
  })

  it('has no "Needs you" group when nothing waits, so an empty heading never leads the tab', () => {
    const groups = groupSharedWorks([item({ id: 'a', timestamp: Date.now(), role: 'viewer' })])
    expect(groups.map((g) => g.label)).toEqual(['Today'])
  })
})

describe('shared sessions are the ones in the reader\'s list with a role below owner', () => {
  it('keeps the shared ones, newest first, with what the card shows', () => {
    const items = buildSharedSessionItems([
      listed({ sessionId: 'own' }),
      listed({ sessionId: 'older', role: 'viewer', lastActivityAt: 10, branch: 'fix/reconnect', status: 'running' }),
      listed({ sessionId: 'newer', role: 'editor', lastActivityAt: 20, runnerOffline: true }),
    ])
    expect(items.map((i) => i.sessionId)).toEqual(['newer', 'older'])
    expect(items[1]).toMatchObject({ role: 'viewer', branch: 'fix/reconnect', status: 'running', projectLabel: 'solus', ownerKey: 'account:ada' })
    expect(items[0]!.runnerOffline).toBe(true)
  })

  it('falls back to the creation time for a session that never reported activity', () => {
    const [only] = buildSharedSessionItems([listed({ sessionId: 's', role: 'viewer', lastActivityAt: 0, createdAt: 5 })])
    expect(only!.timestamp).toBe(5)
  })

  it('leads with the sessions whose agent works now, then buckets the rest by date', () => {
    const now = Date.now()
    const groups = groupSharedSessions(buildSharedSessionItems([
      listed({ sessionId: 'idle-today', role: 'viewer', lastActivityAt: now }),
      listed({ sessionId: 'running-old', role: 'viewer', lastActivityAt: now - 40 * DAY, status: 'running' }),
    ]))
    expect(groups.map((g) => [g.label, g.items.map((i) => i.sessionId)])).toEqual([
      ['Live now', ['running-old']],
      ['Today', ['idle-today']],
    ])
  })

  it('searches the title and the project, case-insensitively', () => {
    const items = buildSharedSessionItems([
      listed({ sessionId: 'a', title: 'Fix reconnect', role: 'viewer' }),
      listed({ sessionId: 'b', title: 'Share sheet', role: 'viewer', projectPath: '/x/mobile' }),
    ])
    expect(applySessionFilter(items, 'RECONNECT').map((i) => i.sessionId)).toEqual(['a'])
    expect(applySessionFilter(items, 'mobile').map((i) => i.sessionId)).toEqual(['b'])
    expect(applySessionFilter(items, '  ')).toBe(items)
  })
})

describe('a card says who else may open the reader\'s own work', () => {
  const HOUR = 3_600_000
  it('leads with the widest reach: the link, then the organization, then the people named', () => {
    expect(shareStateLabel({ named: 0, organization: false, link: null })).toEqual({ glyph: 'private', label: 'Only you' })
    expect(shareStateLabel({ named: 1, organization: false, link: null })).toEqual({ glyph: 'people', label: '1 person' })
    expect(shareStateLabel({ named: 3, organization: false, link: null })).toEqual({ glyph: 'people', label: '3 people' })
    expect(shareStateLabel({ named: 0, organization: true, link: null })).toEqual({ glyph: 'organization', label: 'Organization' })
    expect(shareStateLabel({ named: 2, organization: true, link: null })?.label).toBe('Organization · 2 named')
    expect(shareStateLabel({ named: 2, organization: true, link: { role: 'viewer', expiresAt: null } })).toEqual({ glyph: 'link', label: 'Anyone with link' })
  })

  it('says how long a link has left in the unit that fits, and that it expired', () => {
    const now = 1_000_000
    expect(shareStateLabel({ named: 0, organization: false, link: { role: 'viewer', expiresAt: now + 6 * HOUR } }, now)?.label).toBe('Anyone with link · 6h left')
    expect(shareStateLabel({ named: 0, organization: false, link: { role: 'viewer', expiresAt: now + 72 * HOUR } }, now)?.label).toBe('Anyone with link · 3d left')
    expect(shareStateLabel({ named: 0, organization: false, link: { role: 'viewer', expiresAt: now + 10 * 60_000 } }, now)?.label).toBe('Anyone with link · under an hour left')
    expect(shareStateLabel({ named: 0, organization: false, link: { role: 'viewer', expiresAt: now - 1 } }, now)?.label).toBe('Anyone with link · expired')
  })

  it('says nothing for a host that did not say, rather than guessing "Only you"', () => {
    expect(shareStateLabel(null)).toBeNull()
  })
})
