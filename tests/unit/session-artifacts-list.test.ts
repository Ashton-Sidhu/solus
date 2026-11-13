import { describe, expect, test } from 'bun:test'
import type { SessionArtifact, SessionArtifacts } from '@solus/contracts/session-artifacts'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import {
  artifactDetail,
  artifactIconLabel,
  artifactKindLabel,
  artifactMatchesQuery,
  artifactTitle,
  artifactTooltip,
  fileRouteParams,
} from '@solus/workspace-ui/components/session/artifacts/lib/artifact-list'
import { newestAddedKey } from '@solus/workspace-ui/contexts/sessions/session-artifacts'
import { openArtifact } from '@solus/workspace-ui/components/session/artifacts/lib/artifact-open'
import type { RouteRef } from '@solus/workspace-ui/contexts/workspace/routing/route-registry'

function pr(number: number, linkedAt: number, extra: Partial<SessionPullRequestLink> = {}): SessionArtifact {
  return {
    kind: 'pull-request',
    link: {
      sessionId: 's1',
      repository: 'github.com/acme/app',
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      title: `PR ${number}`,
      source: 'agent',
      linkedAt,
      ...extra,
    },
  }
}

const work = (workId: string, linkedAt: number): SessionArtifact => ({ kind: 'work', workId, title: `Work ${workId}`, workType: 'slides', linkedAt })
const file = (path: string, linkedAt: number): SessionArtifact => ({ kind: 'file', hostId: 'h1', path, title: path, linkedAt })
const app = (appId: string, linkedAt: number, title = `App ${appId}`): SessionArtifact => ({ kind: 'app', hostId: 'h1', appId, slug: `slug-${appId}`, title, linkedAt })

describe('artifact rows', () => {
  test('a file shows its base name and keeps the full path in the tooltip', () => {
    const artifact = file('/repo/src/deep/name.ts', 1)
    expect(artifactTitle(artifact)).toBe('name.ts')
    expect(artifactTooltip(artifact)).toBe('/repo/src/deep/name.ts')
  })

  test('the icon label says a pull request state in words for the tooltip and screen readers', () => {
    // WHY: the row shows status only as an icon; its words must still reach a screen reader.
    const snapshot = { number: 1, url: '', title: '', state: 'open' as const, draft: true, updatedAt: '', baseRepo: { host: 'github.com', owner: 'acme', repo: 'app' } }
    expect(artifactIconLabel(pr(1, 1, { snapshot }))).toBe('Draft pull request')
    expect(artifactIconLabel(pr(1, 1, { snapshot: { ...snapshot, state: 'merged', draft: false } }))).toBe('Merged pull request')
    expect(artifactIconLabel(pr(1, 1, { missing: true }))).toBe('Pull request not found')
    expect(artifactIconLabel(pr(1, 1))).toBe('Pull request')
    expect(artifactIconLabel(work('w', 1))).toBe('Slides')
  })

  test('the row names the kind, a work by its type, and where a pull request or file lives', () => {
    expect(artifactKindLabel(work('w', 1))).toBe('Slides')
    expect(artifactKindLabel(pr(1, 1))).toBe('Pull request')
    expect(artifactDetail(pr(12, 1))).toBe('github.com/acme/app #12')
    expect(artifactDetail(file('/repo/src/a.ts', 1))).toBe('/repo/src')
    expect(artifactDetail(work('w', 1))).toBeNull()
  })

  test('a file opens on the session\'s connection: inside the project in the project, outside in its folder', () => {
    const inside = file('/repo/src/a.ts', 1)
    const outside = file('/tmp/out/b.log', 1)
    if (inside.kind !== 'file' || outside.kind !== 'file') throw new Error('fixture')
    // The link's hostId ('h1') is the machine's id; the route needs the connection.
    expect(fileRouteParams(inside, 'server-a', '/repo')).toEqual({ serverId: 'server-a', cwd: '/repo', path: 'src/a.ts' })
    expect(fileRouteParams(outside, 'server-a', '/repo')).toEqual({ serverId: 'server-a', cwd: '/tmp/out', path: 'b.log' })
  })
})

describe('an app the session linked', () => {
  test('its row is named by its title and says that it is an app', () => {
    // WHY: an app is a kind of its own (docs/plans/apps.md decision 18). It must
    // not read as a work, whose rows open a document.
    expect(artifactTitle(app('app_1', 1, 'Notes'))).toBe('Notes')
    expect(artifactTitle(app('app_1', 1, ''))).toBe('Untitled')
    expect(artifactKindLabel(app('app_1', 1))).toBe('App')
    expect(artifactIconLabel(app('app_1', 1))).toBe('App')
    expect(artifactDetail(app('app_1', 1))).toBeNull()
    expect(artifactMatchesQuery(app('app_1', 1, 'Notes'), 'app')).toBe(true)
  })

  test('a row or a chip opens the app surface beside the conversation, on the session\'s host', () => {
    // WHY: the link holds the machine's id, and the route needs the connection
    // of the session. The artifact carries the app's slug, so the surface a chip
    // opens is the one a link or the Apps tab opens, not a second one.
    const opened: { ref: RouteRef; target: string | undefined }[] = []
    const workspace = {
      router: { navigate: (ref: RouteRef, options?: { target?: string }) => { opened.push({ ref, target: options?.target }) } },
      sessions: { byId: {} },
      serverIdForSession: () => 'server-a',
    } as unknown as Parameters<typeof openArtifact>[0]

    openArtifact(workspace, app('app_1', 1), 'session-1')
    openArtifact(workspace, app('app_2', 1), 'session-1', 'server-b')
    expect(opened).toEqual([
      { ref: { name: 'app', params: { slug: 'slug-app_1', serverId: 'server-a' } }, target: 'companion' },
      { ref: { name: 'app', params: { slug: 'slug-app_2', serverId: 'server-b' } }, target: 'companion' },
    ])
  })
})

describe('artifact search', () => {
  test('finds an artifact by name, full path, pull request reference, or kind, without case', () => {
    // WHY: a reader looks a file up by the folder it is in and a PR by its number,
    // not only by the name the card shows.
    expect(artifactMatchesQuery(file('/repo/src/deep/name.ts', 1), 'DEEP/')).toBe(true)
    expect(artifactMatchesQuery(pr(42, 1), 'app#42')).toBe(true)
    expect(artifactMatchesQuery(work('w1', 1), 'slides')).toBe(true)
    expect(artifactMatchesQuery(work('w1', 1), 'diagram')).toBe(false)
    expect(artifactMatchesQuery(work('w1', 1), '   ')).toBe(true)
  })
})

describe('newest added artifact', () => {
  test('names the newest item the next read added, and nothing when none was added', () => {
    const before: SessionArtifacts = { own: [work('w1', 1)], children: [] }
    const after: SessionArtifacts = { own: [work('w1', 1), file('/r/a', 4)], children: [{ sessionId: 'c', title: 'c', items: [pr(3, 6)] }] }
    expect(newestAddedKey(before, after)).toBe('pull-request:github.com/acme/app#3')
    expect(newestAddedKey(after, before)).toBeNull()
  })
})
