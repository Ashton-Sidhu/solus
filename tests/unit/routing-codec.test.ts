import { describe, expect, test } from 'bun:test'
import { parseLocation, parseRoute, serializeLocation, serializeRoute } from '@solus/workspace-ui/contexts/workspace/routing/codec'
import { makePane, type Location } from '@solus/workspace-ui/contexts/workspace/routing/location'
import {
  CHAT_ROUTE,
  ROUTES,
  ROUTE_NAMES,
  serializeRef,
  type RouteRef,
} from '@solus/workspace-ui/contexts/workspace/routing/route-registry'

// One codec serves the address bar, the in-memory history, the persisted
// snapshot, agent links, and notification payloads — so a route that does not
// survive a round trip breaks five things at once.

/** A representative ref per destination, exercising every params shape. */
const SAMPLES: RouteRef[] = [
  { name: 'chat', params: {} },
  { name: 'chat', params: { sessionId: 'sess_abc' } },
  { name: 'chat', params: { sessionId: 'sess_9' } },
  { name: 'chat', params: { sessionId: 'sess_remote', serverId: 'studio-host' } },
  { name: 'tasks', params: {} as Record<string, never> },
  { name: 'task', params: { taskId: 'SOL-12' } },
  { name: 'prs', params: { projectPath: '/repo/app' } },
  { name: 'insights', params: {} },
  { name: 'insights', params: { traceId: 'tr_9f2a41' } },
  { name: 'insights', params: { traceId: 'tr_9f2a41', spanId: 'sp_11' } },
  { name: 'reviewMode', params: {} as Record<string, never> },
  { name: 'settings', params: { tab: 'voice' } },
  { name: 'settings', params: { tab: 'projects', projectCwd: '/repo/app' } },
  { name: 'folio', params: {} as Record<string, never> },
  { name: 'automations', params: {} },
  { name: 'automations', params: { automationId: 'a_3' } },
  { name: 'plan', params: { planId: 'p_88' } },
  { name: 'plan', params: { planId: null } },
  { name: 'work', params: { workId: 'w_12' } },
  { name: 'work', params: { workId: 'w_remote', serverId: 'studio-host' } },
  { name: 'automation', params: { automationId: 'a_3' } },
  { name: 'automation', params: { automationId: null } },
  { name: 'automation', params: { automationId: null, serverId: 'remote-host' } },
  { name: 'goal', params: { sessionId: 'sess_abc' } },
  { name: 'review', params: { sourceTabId: 'tab_a', view: 'map' } },
  { name: 'review', params: { sourceTabId: 'tab_a', view: 'guide' } },
  { name: 'review', params: { sourceTabId: 'tab_a', view: 'guide', scope: { kind: 'session' } } },
  { name: 'prReview', params: { number: 4821 } },
  { name: 'prReview', params: { number: 4821, cwd: '/repo/app' } },
  { name: 'prReview', params: { number: 4821, cwd: '/repo/app', serverId: 'host_remote' } },
  { name: 'prDiff', params: { number: 4821 } },
  { name: 'prDiff', params: { number: 4821, cwd: '/repo/app' } },
  { name: 'draft', params: { draftId: 'draft_a' } },
  { name: 'review', params: { sourceTabId: 'tab_a', view: 'diff', scope: { kind: 'session' } } },
  { name: 'review', params: { sourceTabId: 'tab_a', view: 'diff', scope: { kind: 'working-tree' } } },
  { name: 'review', params: { sourceTabId: 'tab_a', view: 'diff', scope: { kind: 'turn', index: 3 } } },
  { name: 'review', params: { sourceTabId: 'tab_a', view: 'map', scope: { kind: 'pr', baseSha: 'abc123' } } },
  { name: 'review', params: { sourceTabId: 'tab_a', view: 'diff', scope: { kind: 'session' }, filePath: 'src/a/b.ts' } },
  { name: 'files', params: { serverId: 'host_a', cwd: '/repo/app' } },
  { name: 'fileEditor', params: { sourceId: 'tab_a', path: 'src/a/b.ts' } },
  { name: 'fileEditor', params: { sourceId: 'tab_a', path: 'src/a/b.ts', line: 412 } },
  { name: 'subagent', params: { sessionId: 'sess_a', messageId: 'msg_1' } },
  { name: 'browser', params: {} },
  { name: 'browser', params: { browserPageId: 'browser_7' } },
  { name: 'browser', params: { browserPageId: 'browser_7', serverId: 'studio-host' } },
]

function locationOf(...refs: RouteRef[]): Location {
  const panes = refs.map((ref) => makePane(ref))
  return { panes, focusedPaneId: panes[panes.length - 1].id }
}

describe('route codec', () => {
  test('every destination is covered by a sample', () => {
    expect([...new Set(SAMPLES.map((ref) => ref.name))].sort()).toEqual([...ROUTE_NAMES].sort())
  })

  test('every sample round-trips through a single-route link', () => {
    for (const ref of SAMPLES) {
      expect(parseRoute(serializeRoute(ref))).toEqual(ref)
    }
  })

  test('every sample round-trips as the leading pane of a location', () => {
    for (const ref of SAMPLES) {
      const parsed = parseLocation(serializeLocation(locationOf(ref)))
      expect(parsed.panes.map((pane) => pane.base)).toEqual([ref])
    }
  })
})

describe('the pane grammar', () => {
  test('a review without an explicit view opens on the diff', () => {
    expect(parseRoute('/review/tab_a')).toEqual({
      name: 'review',
      params: { sourceTabId: 'tab_a', view: 'diff' },
    })
    expect(serializeRoute({ name: 'review', params: { sourceTabId: 'tab_a' } }))
      .toBe('/review/tab_a/diff/branch')
  })

  test('one pane is just a path', () => {
    expect(serializeLocation(locationOf({ name: 'chat', params: { sessionId: 'sess_abc' } })))
      .toBe('/chat/sess_abc')
  })

  test('two panes with focus on the right', () => {
    const location = locationOf(
      { name: 'chat', params: { sessionId: 'sess_abc' } },
      { name: 'prReview', params: { number: 4821 } },
    )
    expect(serializeLocation(location)).toBe('/chat/sess_abc?p=prReview%2F4821&f=1')
  })

  test('an overlay attaches to its pane with `!`', () => {
    const location = locationOf({ name: 'chat', params: { sessionId: 'sess_abc' } })
    location.panes.push(
      makePane(
        { name: 'prReview', params: { number: 4821 } },
        { name: 'review', params: { sourceTabId: 'tab_abc', view: 'map' } },
      ),
    )
    const text = serializeLocation(location)
    expect(text).toContain('prReview%2F4821%21review%2Ftab_abc%2Fmap%2Fbranch')
    expect(parseLocation(text).panes[1]).toMatchObject({
      base: { name: 'prReview', params: { number: 4821 } },
      overlay: { name: 'review' },
    })
  })

  test('adding a pane adds a `p` — the grammar is not two-pane-shaped', () => {
    for (const count of [3, 4]) {
      const refs = ([
        { name: 'chat', params: { sessionId: 'sess_abc' } },
        { name: 'plan', params: { planId: 'p_88' } },
        { name: 'work', params: { workId: 'w_12' } },
        { name: 'tasks', params: {} },
      ] as RouteRef[]).slice(0, count)

      const parsed = parseLocation(serializeLocation(locationOf(...refs)))
      expect(parsed.panes).toHaveLength(count)
      expect(parsed.panes.map((pane) => pane.base)).toEqual(refs)
      expect(parsed.panes.findIndex((pane) => pane.id === parsed.focusedPaneId)).toBe(count - 1)
    }
  })

  test('a diff link written before the review pane existed opens the same change', () => {
    // The diff and the review guide became one destination. A persisted
    // location, an agent link, or a notification written against either old
    // grammar has to land on the same change and the same view — the two old
    // names put different things in the second segment, so reading one with the
    // other's parser would silently mis-seat every field.
    expect(parseRoute('/diff/tab_a/working-tree')).toEqual({
      name: 'review',
      params: { sourceTabId: 'tab_a', view: 'diff', scope: { kind: 'working-tree' } },
    })
    expect(parseRoute('/diff/tab_a/session/src/a/b.ts')).toEqual({
      name: 'review',
      params: {
        sourceTabId: 'tab_a',
        view: 'diff',
        scope: { kind: 'session' },
        filePath: 'src/a/b.ts',
      },
    })
  })

  test('a guide link written before the review pane existed opens the guide', () => {
    // The cached-guide key the old route carried is derivable from the
    // checkout, so it is dropped rather than kept as a thing to keep in sync.
    expect(parseRoute('/review/solus__fix/branch/tab_a')).toEqual({
      name: 'review',
      params: { sourceTabId: 'tab_a', view: 'guide' },
    })

    expect(parseRoute('/review/solus__fix/session/tab_a')).toEqual({
      name: 'review',
      params: { sourceTabId: 'tab_a', view: 'guide', scope: { kind: 'session' } },
    })
  })

  test('a file opened before the line slot existed still opens that file', () => {
    // A persisted location or an agent link written against the older
    // `<tab>/<path>` grammar must not silently resolve to a different file.
    expect(parseRoute('/fileEditor/tab_a/src/a/b.ts')).toEqual({
      name: 'fileEditor',
      params: { sourceId: 'tab_a', path: 'src/a/b.ts' },
    })
  })

  test('a path whose first segment is numeric is not read as a line', () => {
    expect(parseRoute('/fileEditor/tab_a/-/2024/report.md')).toEqual({
      name: 'fileEditor',
      params: { sourceId: 'tab_a', path: '2024/report.md' },
    })
  })

  test('the file tree route owns its host and directory, not a draft or tab', () => {
    // A draft disappears when its first prompt starts a session. Keeping only
    // the resolved filesystem target prevents that lifecycle change from
    // reloading the open tree or moving it to the default host.
    const ref: RouteRef<'files'> = {
      name: 'files',
      params: { serverId: 'remote-host', cwd: '/srv/project' },
    }

    expect(parseRoute(serializeRoute(ref))).toEqual(ref)
    expect(parseRoute('/files/draft_a')).toBeNull()
  })

  test('a companion chat that names no session is dropped', () => {
    // A chat naming no session is the conversation pool's, and only the leading
    // pane renders the pool. Restored beside it, the companion showed whichever
    // tab the pool was on — so starting a session in the leading pane put the
    // same conversation on both sides of the split.
    const parsed = parseLocation('/chat?p=chat&p=plan%2Fp_88')

    expect(parsed.panes.map((pane) => pane.base)).toEqual([
      CHAT_ROUTE,
      { name: 'plan', params: { planId: 'p_88' } },
    ])
  })

  test('a companion opened for an overlay keeps it when its chat is dropped', () => {
    const parsed = parseLocation('/chat?p=chat%21files%2Fhost_a%2F%2Frepo%2Fapp')

    expect(parsed.panes).toHaveLength(2)
    expect(parsed.panes[1].base).toBeNull()
    expect(parsed.panes[1].overlay).toEqual({
      name: 'files',
      params: { serverId: 'host_a', cwd: '/repo/app' },
    })
  })

  test('a companion chat that names its session is kept', () => {
    const parsed = parseLocation('/chat?p=chat%2Fsess_abc')

    expect(parsed.panes.map((pane) => pane.base)).toEqual([
      CHAT_ROUTE,
      { name: 'chat', params: { sessionId: 'sess_abc' } },
    ])
  })

  test('a pane may exist for its overlay alone', () => {
    const location = locationOf({ name: 'chat', params: {} })
    location.panes.push(
      makePane(null, {
        name: 'files',
        params: { serverId: 'host_a', cwd: '/repo/app' },
      }),
    )

    const parsed = parseLocation(serializeLocation(location))

    expect(parsed.panes[1].base).toBeNull()
    expect(parsed.panes[1].overlay).toEqual({
      name: 'files',
      params: { serverId: 'host_a', cwd: '/repo/app' },
    })
  })
})

describe('untrusted input', () => {
  // URLs and notification payloads are untrusted, so `parse` is total: a pane
  // that cannot be read is dropped and the rest of the location still opens.
  test('an unknown destination drops its pane, not the location', () => {
    const parsed = parseLocation('/chat/sess_abc?p=nonsense%2F1&p=plan%2Fp_88&f=2')

    expect(parsed.panes.map((pane) => pane.base)).toEqual([
      { name: 'chat', params: { sessionId: 'sess_abc' } },
      { name: 'plan', params: { planId: 'p_88' } },
    ])
  })

  test('garbage params drop their pane', () => {
    const parsed = parseLocation('/chat?p=prReview%2Fnot-a-number')
    expect(parsed.panes).toHaveLength(1)
  })

  test('an unreadable leading pane falls back to the conversation', () => {
    expect(parseLocation('/nonsense').panes[0].base).toEqual(CHAT_ROUTE)
    expect(parseLocation('').panes[0].base).toEqual(CHAT_ROUTE)
  })

  test('malformed percent-encoding never escapes the parser', () => {
    expect(parseLocation('#/settings/%E0%A4%A').panes[0].base).toEqual(CHAT_ROUTE)
    expect(parseRoute('#/chat/%')).toBeNull()
  })

  test('invalid settings tabs fall back to the conversation', () => {
    expect(parseLocation('#/settings/connections').panes[0].base).toEqual(CHAT_ROUTE)
    expect(parseLocation('#/settings/keybindings').panes[0].base).toEqual({
      name: 'settings',
      params: { tab: 'keybindings' },
    })
    expect(parseLocation('#/settings/source-control').panes[0].base).toEqual({
      name: 'settings',
      params: { tab: 'source-control' },
    })
  })

  test('reserved characters survive one path decode', () => {
    const location = locationOf(
      { name: 'chat', params: { sessionId: 'sess/% with spaces' } },
      { name: 'files', params: { serverId: 'host% with spaces', cwd: '/repo/% with spaces' } },
    )

    expect(parseLocation(serializeLocation(location)).panes.map((pane) => pane.base))
      .toEqual(location.panes.map((pane) => pane.base))
  })

  test('an out-of-range focus index falls back to the leading pane', () => {
    const parsed = parseLocation('/chat?p=tasks&f=9')
    expect(parsed.focusedPaneId).toBe(parsed.panes[0].id)
  })

  test('a leading pane may not be overlay-only', () => {
    const parsed = parseLocation('/!files%2Fhost_a%2F%2Frepo%2Fapp')
    expect(parsed.panes[0].base).toEqual(CHAT_ROUTE)
  })

  test('every descriptor parses garbage without throwing', () => {
    for (const name of ROUTE_NAMES) {
      expect(() => ROUTES[name].parse('%%%/../\0')).not.toThrow()
    }
  })
})

describe('link serialization', () => {
  test('a ref with no params is just its name', () => {
    const folio: RouteRef = { name: 'folio', params: {} as Record<string, never> }
    expect(serializeRef(folio)).toBe('folio')
    expect(serializeRoute(folio)).toBe('/folio')
  })

  test('a PR review link is the number the notification carries', () => {
    expect(serializeRoute({ name: 'prReview', params: { number: 4821 } })).toBe('/prReview/4821')
  })

  test("a chat link is the session it shows, not the tab showing it", () => {
    expect(serializeRoute({ name: 'chat', params: { sessionId: 'sess_9' } })).toBe('/chat/sess_9')
  })
})
