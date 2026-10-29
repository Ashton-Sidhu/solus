import { describe, expect, test } from 'bun:test'
import type { SessionArtifact, SessionArtifacts } from '@solus/contracts/session-artifacts'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import {
  artifactDetail,
  artifactIconLabel,
  artifactKindLabel,
  artifactMatchesQuery,
  artifactSections,
  artifactTitle,
  artifactTooltip,
  effectiveFilter,
  fileRouteParams,
  filterChips,
} from '@solus/workspace-ui/components/session/artifacts/lib/artifact-list'
import { artifactKey, newestAddedKey } from '@solus/workspace-ui/contexts/sessions/session-artifacts'

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
const image = (path: string, linkedAt: number): SessionArtifact => ({ kind: 'image', hostId: 'h1', path, title: path, linkedAt })

describe('artifact filter chips', () => {
  test('All counts every artifact, own and children, and a kind with no items has no chip', () => {
    // WHY: a chip that filters to nothing is a dead end; All must count what the list holds.
    const artifacts: SessionArtifacts = {
      own: [pr(1, 1), work('w1', 2)],
      children: [{ sessionId: 'c1', title: 'Child', items: [file('/repo/a.ts', 3)] }],
    }
    expect(filterChips(artifacts).map((chip) => [chip.filter, chip.count])).toEqual([
      ['all', 3],
      ['pull-request', 1],
      ['work', 1],
      ['file', 1],
    ])
  })

  test('a filter whose kind emptied falls back to All', () => {
    const chips = filterChips({ own: [work('w1', 1)], children: [] })
    expect(effectiveFilter('image', chips)).toBe('all')
    expect(effectiveFilter('work', chips)).toBe('work')
  })
})

describe('artifact sections', () => {
  test('a plain session groups by kind, newest first, and leaves out empty kinds', () => {
    const sections = artifactSections({ own: [file('/r/a', 1), pr(7, 5), file('/r/b', 9)], children: [] }, 'all')
    expect(sections.map((section) => section.title)).toEqual(['Pull requests', 'Files'])
    expect(sections[1]!.items.map(artifactKey)).toEqual(['file:h1:/r/b', 'file:h1:/r/a'])
  })

  test('a lead shows its own first, then one section per child by name', () => {
    // WHY: a lead's work is spread over the sessions it started; each child's
    // output must stay under that child's name, after the lead's own.
    const artifacts: SessionArtifacts = {
      own: [work('w1', 1)],
      children: [
        { sessionId: 'c1', title: 'Fix login', items: [pr(2, 2)] },
        { sessionId: 'c2', title: null, items: [image('/r/shot.png', 3)] },
      ],
    }
    expect(artifactSections(artifacts, 'all').map((section) => [section.key, section.title])).toEqual([
      ['own', 'This session'],
      ['session:c1', 'Fix login'],
      ['session:c2', 'Untitled session'],
    ])
    expect(artifactSections(artifacts, 'pull-request').map((section) => section.key)).toEqual(['session:c1'])
  })
})

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

  test('sections keep only what the search finds, under the kind filter, and drop the empty ones', () => {
    const artifacts: SessionArtifacts = {
      own: [file('/r/login.ts', 1), pr(3, 2, { title: 'Fix login' })],
      children: [{ sessionId: 'c1', title: 'Child', items: [file('/r/other.ts', 3)] }],
    }
    expect(artifactSections(artifacts, 'all', 'login').map((section) => [section.key, section.items.map(artifactKey)])).toEqual([
      ['own', ['pull-request:github.com/acme/app#3', 'file:h1:/r/login.ts']],
    ])
    expect(artifactSections(artifacts, 'file', 'login').map((section) => section.items.map(artifactKey))).toEqual([['file:h1:/r/login.ts']])
    expect(artifactSections({ own: artifacts.own, children: [] }, 'all', 'login').map((section) => section.title)).toEqual(['Pull requests', 'Files'])
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
