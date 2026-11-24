import { describe, expect, test } from 'bun:test'
import type { AppSummary } from '@solus/contracts/apps'
import type { Work } from '@solus/contracts/types'
import { workItem } from '@solus/workspace-ui/components/workspace/lib/workspace-items'
import { buildWorkspaceAppItems } from '@solus/workspace-ui/components/workspace/lib/workspace-apps'
import { workspaceRecentItems } from '@solus/workspace-ui/components/workspace/lib/workspace-recent'

/**
 * The Workspace page's "Recently viewed" row (docs/workspace-page.md): the
 * works and apps the person opened, from their history, newest open first.
 */

const PROJECT = { key: '/repo', label: 'repo', roots: ['/repo'] }
const work = (id: string, pinned = false) =>
  workItem({ id, title: id, type: 'doc', preview: '', pinned, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', cwd: '/repo' } as Work, PROJECT)
const notesApp: AppSummary = {
  id: 'a1', slug: 'notes', name: 'Notes', description: '', organizationId: 'local', activeVersion: 1, latestVersion: 1,
  latestRevision: 'a'.repeat(40), hasUndeployedRevision: false, buildingVersion: null, stopped: false, agentAccess: true, hasUi: true,
  operationCount: 1, project: '/repo', createdBy: { kind: 'system' }, createdAt: 0, updatedAt: 0, lastCallAt: null, calls24h: 0, failed24h: 0, attention: [],
}
const apps = buildWorkspaceAppItems(
  [{ serverId: 'local', app: notesApp }],
  { hostLabel: () => 'Laptop', projectKeyOf: () => '/repo', optionsFor: () => [] },
)

const sources = {
  works: [work('w1'), work('w2', true), work('w3')],
  apps,
  workHostOf: (workId: string) => (workId === 'w3' ? null : 'local'),
  // The desktop reaches its own host as `local`; every client names it by its installation id.
  machineIdOf: (serverId: string) => (serverId === 'local' ? 'install-1' : serverId),
}

describe('the Workspace page’s Recently viewed row', () => {
  test('holds what the person opened, newest open first, whatever is pinned', () => {
    const row = workspaceRecentItems({
      ...sources,
      history: [
        { key: 'app:install-1:a1', openedAt: 3_000 },
        { key: 'work:w1', openedAt: 2_000 },
        { key: 'work:w2', openedAt: 1_000 },
      ],
    })
    expect(row.map((item) => [item.artifact.kind, item.at])).toEqual([['app', 3_000], ['work', 2_000], ['work', 1_000]])
    expect(row[0]).toMatchObject({ kind: 'app', serverId: 'local', artifact: { hostId: 'install-1', appId: 'a1' } })
  })

  test('an app opened from a session’s Threads names the same machine as the page', () => {
    // WHY: a link names the machine by its installation id. The page must find
    // the app the person opened from a session, not only from the page.
    const row = workspaceRecentItems({ ...sources, history: [{ key: 'app:install-1:a1', openedAt: 1 }] })
    expect(row).toHaveLength(1)
  })

  test('leaves out what the page does not list, and holds at most its limit', () => {
    const row = workspaceRecentItems({
      ...sources,
      history: [
        { key: 'work:deleted', openedAt: 9_000 },
        { key: 'file:install-1:/tmp/a.txt', openedAt: 8_000 },
        // A work whose host this client does not know cannot open.
        { key: 'work:w3', openedAt: 7_000 },
        { key: 'work:w1', openedAt: 6_000 },
        { key: 'work:w2', openedAt: 5_000 },
      ],
    }, 1)
    expect(row.map((item) => item.artifact.kind === 'work' && item.artifact.workId)).toEqual(['w1'])
  })

  test('is empty until the person opened something', () => {
    expect(workspaceRecentItems({ ...sources, history: [] })).toEqual([])
  })
})
