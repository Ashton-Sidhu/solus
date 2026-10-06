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
  { name: 'notifications', params: {} as Record<string, never> },
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
  { name: 'files', params: { serverId: 'host_a', cwd: '/repo/app', path: 'src/a/b.ts' } },
  { name: 'files', params: { serverId: 'host_a', cwd: '/repo/app', path: 'src/a/b.ts', line: 412 } },
  { name: 'subagent', params: { sessionId: 'sess_a', messageId: 'msg_1' } },
  { name: 'sessionRecord', params: { sessionId: 'sess_a', serverId: 'workspace:org-1' } },
  { name: 'browser', params: {} },
  { name: 'browser', params: { browserPageId: 'browser_7' } },
  { name: 'browser', params: { browserPageId: 'browser_7', serverId: 'studio-host' } },
  { name: 'devices', params: {} },
  { name: 'devices', params: { sessionId: 'sess_a', serverId: 'studio-host' } },
]

/** A location with this destination and, after it, this strip. Focus is on
 *  the strip when there is one. */
function locationOf(destination: RouteRef, ...surfaces: RouteRef[]): Location {
  const panes = [makePane([destination])]
  if (surfaces.length > 0) panes.push(makePane(surfaces))
  return { panes, focusedPaneId: panes[panes.length - 1].id }
}

const SESSION_CHAT: RouteRef = { name: 'chat', params: { sessionId: 'sess_abc' } }
const PLAN: RouteRef = { name: 'plan', params: { planId: 'p_88' } }
const WORK: RouteRef = { name: 'work', params: { workId: 'w_12' } }
const PR_REVIEW: RouteRef = { name: 'prReview', params: { number: 4821 } }

describe('route codec', () => {
  test('every destination is covered by a sample', () => {
    expect([...new Set(SAMPLES.map((ref) => ref.name))].sort()).toEqual([...ROUTE_NAMES].sort())
  })

  test('every sample round-trips through a single-route link', () => {
    for (const ref of SAMPLES) {
      expect(parseRoute(serializeRoute(ref))).toEqual(ref)
    }
  })

  test('every sample round-trips in the pane its placement gives it', () => {
    for (const ref of SAMPLES) {
      const isSurface = ROUTES[ref.name].placement === 'surface'
      // The pool's chat names no session, so it can only lead.
      if (ref.name === 'chat' && !ref.params.sessionId) continue
      const location = isSurface ? locationOf(CHAT_ROUTE, ref) : locationOf(ref)
      const parsed = parseLocation(serializeLocation(location))
      expect(parsed.panes.map((pane) => pane.surfaces)).toEqual(location.panes.map((pane) => pane.surfaces))
    }
  })
})

describe('the location grammar', () => {
  test('a review without an explicit view opens on the diff', () => {
    expect(parseRoute('/review/tab_a')).toEqual({
      name: 'review',
      params: { sourceTabId: 'tab_a', view: 'diff' },
    })
    expect(serializeRoute({ name: 'review', params: { sourceTabId: 'tab_a' } }))
      .toBe('/review/tab_a/diff/branch')
  })

  test('a destination alone is just a path', () => {
    expect(serializeLocation(locationOf({ name: 'tasks', params: {} }))).toBe('/tasks')
  })

  test('one surface beside the destination, focus on it', () => {
    expect(serializeLocation(locationOf(CHAT_ROUTE, PR_REVIEW))).toBe('/chat?p=prReview%2F4821&f=1')
  })

  test('the strip joins its surfaces with `!` and names a non-last active one with `a`', () => {
    const location = locationOf({ name: 'tasks', params: {} }, PLAN, SESSION_CHAT, WORK)
    location.panes[1].activeSurfaceIndex = 1
    const text = serializeLocation(location)

    expect(text).toContain('p=plan%2Fp_88%21chat%2Fsess_abc%21work%2Fw_12')
    expect(text).toContain('a=1')
    const parsed = parseLocation(text)
    expect(parsed.panes[1].surfaces).toEqual([PLAN, SESSION_CHAT, WORK])
    expect(parsed.panes[1].activeSurfaceIndex).toBe(1)
  })

  test('without `a` the last surface is active', () => {
    const parsed = parseLocation('/chat?p=plan%2Fp_88%21work%2Fw_12')
    expect(parsed.panes[1].activeSurfaceIndex).toBe(1)
  })

  test('a link to a surface opens it beside the conversation, never in the leading pane', () => {
    // WHY: the leading pane only ever holds a destination; `/task/T1` from an
    // agent or a notification opens the task as a surface.
    const parsed = parseLocation('/task/SOL-12')

    expect(parsed.panes[0].surfaces).toEqual([CHAT_ROUTE])
    expect(parsed.panes[1].surfaces).toEqual([{ name: 'task', params: { taskId: 'SOL-12' } }])
    expect(parsed.focusedPaneId).toBe(parsed.panes[1].id)
  })

  test('the removed standalone file editor route is no longer accepted', () => {
    expect(parseRoute('/fileEditor/tab_a/src/a/b.ts')).toBeNull()
  })

  test('file selection preserves absolute paths, special characters, and a line', () => {
    const ref: RouteRef<'files'> = {
      name: 'files',
      params: { serverId: 'host_a', cwd: '/repo/app ?#%', path: '/repo/app ?#%/2024/report.md', line: 30 },
    }
    expect(parseRoute(serializeRoute(ref))).toEqual(ref)
  })

  test('malformed file selection cannot break location restoration', () => {
    expect(parseRoute('/files/host_a/@file/%25ZZ/30/src/a.ts')).toBeNull()
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

  test('a chat surface that names no session is dropped', () => {
    // A chat naming no session is the conversation pool's, and only the leading
    // pane renders the pool. As a surface it would show the same conversation
    // on both sides of the split.
    const parsed = parseLocation('/chat?p=chat%21plan%2Fp_88')

    expect(parsed.panes[1].surfaces).toEqual([PLAN])
  })

  test('a chat surface that names its session is kept', () => {
    const parsed = parseLocation('/chat?p=chat%2Fsess_abc')

    expect(parsed.panes[1].surfaces).toEqual([SESSION_CHAT])
  })
})

describe('untrusted input', () => {
  // URLs and notification payloads are untrusted, so `parse` is total: a
  // surface that cannot be read is dropped and the rest of the location opens.
  test('an unknown route drops its surface, not the strip', () => {
    const parsed = parseLocation('/chat/sess_abc?p=nonsense%2F1%21plan%2Fp_88&f=1')

    expect(parsed.panes[0].surfaces).toEqual([SESSION_CHAT])
    expect(parsed.panes[1].surfaces).toEqual([PLAN])
  })

  test('a strip with nothing readable leaves no companion pane', () => {
    const parsed = parseLocation('/chat?p=prReview%2Fnot-a-number')
    expect(parsed.panes).toHaveLength(1)
  })

  test('an unreadable leading pane falls back to the conversation', () => {
    expect(parseLocation('/nonsense').panes[0].surfaces).toEqual([CHAT_ROUTE])
    expect(parseLocation('').panes[0].surfaces).toEqual([CHAT_ROUTE])
  })

  test('malformed percent-encoding never escapes the parser', () => {
    expect(parseLocation('#/settings/%E0%A4%A').panes[0].surfaces).toEqual([CHAT_ROUTE])
    expect(parseRoute('#/chat/%')).toBeNull()
  })

  test('invalid settings tabs fall back to the conversation', () => {
    expect(parseLocation('#/settings/connections').panes[0].surfaces).toEqual([CHAT_ROUTE])
    expect(parseLocation('#/settings/keybindings').panes[0].surfaces).toEqual([{
      name: 'settings',
      params: { tab: 'keybindings' },
    }])
  })

  test('reserved characters survive one path decode', () => {
    const location = locationOf(
      { name: 'chat', params: { sessionId: 'sess/% with spaces' } },
      { name: 'files', params: { serverId: 'host% with spaces', cwd: '/repo/% with spaces' } },
    )

    expect(parseLocation(serializeLocation(location)).panes.map((pane) => pane.surfaces))
      .toEqual(location.panes.map((pane) => pane.surfaces))
  })

  test('an out-of-range active surface falls back to the last one', () => {
    const parsed = parseLocation('/chat?p=plan%2Fp_88%21work%2Fw_12&a=9')
    expect(parsed.panes[1].activeSurfaceIndex).toBe(1)
  })

  test('focus on a companion pane that is not there falls back to the leading pane', () => {
    const parsed = parseLocation('/chat?f=1')
    expect(parsed.focusedPaneId).toBe(parsed.panes[0].id)
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
