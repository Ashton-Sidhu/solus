import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PlanDescriptor, Work } from '@solus/contracts/types'
import {
  buildWorkspaceItems,
  formatGeneratedDate,
  formatGeneratedFull,
  groupItems,
  initialWorkspaceProject,
  isHtmlArtifact,
  planItem,
  projectsForWorkspaceScope,
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
    type: 'plan',
    glyph: 'plan',
    title: over.id,
    snippet: '',
    createdAt: 0,
    sessionId: null,
    pinned: false,
    pinnedAt: over.timestamp,
    cwd: '/repo',
    projectKey: '/repo',
    projectLabel: 'repo',
    status: null,
    source: { kind: 'work', work: {} as never },
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

describe('a project selected from Workspace history', () => {
  it('attributes and shows its artifacts before any session is open in it', () => {
    const catalogProject: WorkspaceProject = { key: '/catalog', label: 'catalog', roots: ['/catalog'] }
    const selectedProject = { key: '/catalog-only', label: 'catalog-only' }
    const projects = projectsForWorkspaceScope([catalogProject], selectedProject)
    const work = {
      id: 'catalog-work',
      type: 'doc',
      title: 'Loaded from the selected project',
      preview: '',
      createdAt: '2026-08-28T12:00:00Z',
      updatedAt: '2026-08-28T12:00:00Z',
      cwd: '/catalog-only',
    } as Work

    expect(buildWorkspaceItems([], [work], projects).map((item) => item.id)).toEqual([
      'catalog-work',
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

describe('Workspace initial project ownership', () => {
  const defaultInput = { workingDirectory: '/input-default', gitContext: null }

  it('starts on the active session project instead of another input-bar project', () => {
    const activeSessionRun = {
      serverId: 'host-a',
      workingDirectory: '/active-worktree',
      gitContext: { repoRoot: '/active-project' },
    }
    const inputBarRun = {
      serverId: 'host-b',
      workingDirectory: '/input-project',
      gitContext: null,
    }

    expect(initialWorkspaceProject(activeSessionRun, inputBarRun, defaultInput, 'default')).toEqual({
      serverId: 'host-a',
      projectRoot: '/active-project',
    })
  })

  it('uses the input-bar project when there is no active session', () => {
    const inputBarRun = {
      serverId: 'host-b',
      workingDirectory: '/input-project',
      gitContext: null,
    }

    expect(initialWorkspaceProject(undefined, inputBarRun, defaultInput, 'default')).toEqual({
      serverId: 'host-b',
      projectRoot: '/input-project',
    })
  })

  it('uses the input-bar default only when neither session nor draft owns a run', () => {
    expect(initialWorkspaceProject(undefined, undefined, defaultInput, 'default')).toEqual({
      serverId: 'default',
      projectRoot: '/input-default',
    })
  })

  it('does not keep a live dependency on the projects of open sessions', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '../../packages/workspace-ui/src/components/workspace/WorkspacePage.svelte'),
      'utf8',
    )

    expect(source).not.toContain('session.openProjects')
    expect(source).not.toContain('session.galleryProjectPath')
    expect(source).not.toContain('PROJECT_SCOPE_KEY')
    expect(source).toContain('serversStore.recentProjectsFor(serverId)')
  })
})

describe('a row is marked with what actually made it', () => {
  const PROJECT: WorkspaceProject = { key: '/repo', label: 'repo', roots: ['/repo'] }
  const plan = (provider?: string) =>
    planItem({ provider, sessionId: 's', planToolUseId: 't', cwd: '/repo' } as PlanDescriptor, PROJECT)
      .glyph
  const work = (type: string) =>
    workItem({ id: 'w', type, updatedAt: '2026-01-01T00:00:00Z', cwd: '/repo' } as Work, PROJECT).glyph

  it('gives a plan the logo of the agent that wrote it — the ledger is scanned for "the one Codex made"', () => {
    expect(plan('claude-code')).toBe('claude')
    expect(plan('codex')).toBe('codex')
  })

  it('falls back to the generic plan mark rather than guessing an agent', () => {
    expect(plan(undefined)).toBe('plan')
    expect(plan('opencode')).toBe('plan')
  })

  it('keeps each work format on the icon Solus already uses for it, slides included', () => {
    expect(work('doc')).toBe('doc')
    expect(work('slides')).toBe('slides')
    expect(work('diagram')).toBe('diagram')
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
    const planRow = planItem({ sessionId: 's', planToolUseId: 't', cwd: '/repo' } as PlanDescriptor, PROJECT)

    expect(upstreamProviderFor(linked)).toBe('gdrive')
    expect(upstreamProviderFor(local)).toBeNull()
    expect(upstreamProviderFor(planRow)).toBeNull()
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

  it('generates a plan once: it was written when it was written', () => {
    const built = planItem(
      { sessionId: 's', planToolUseId: 't', cwd: '/repo', timestamp: 1_700_000_000_000 } as PlanDescriptor,
      PROJECT,
    )
    expect(built.sessionId).toBe('s')
    expect(built.createdAt).toBe(built.timestamp)
  })

  it('keeps matching plan ids from different hosts as separate renderer rows', () => {
    const descriptors = [
      { serverId: 'host-a', sessionId: 'session', planToolUseId: 'tool', cwd: '/repo', timestamp: 2 },
      { serverId: 'host-b', sessionId: 'session', planToolUseId: 'tool', cwd: '/repo', timestamp: 1 },
    ] as PlanDescriptor[]

    const built = buildWorkspaceItems(descriptors, [], [PROJECT])

    expect(built.map((entry) => entry.id)).toEqual(['session__tool', 'session__tool'])
    expect(new Set(built.map((entry) => entry.rowKey)).size).toBe(2)
  })

  it('collapses an exact duplicate plan row from one host', () => {
    const descriptor = {
      serverId: 'host-a',
      sessionId: 'session',
      planToolUseId: 'tool',
      cwd: '/repo',
      timestamp: 1,
    } as PlanDescriptor

    expect(buildWorkspaceItems([descriptor, descriptor], [], [PROJECT])).toHaveLength(1)
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
