import { describe, expect, test } from 'bun:test'
import type { Session, SessionMeta, Tab } from '../../src/shared/types'
import {
  dedupeHistoryEntries,
  filterEntries,
  SearchTextCache,
} from '../../src/renderer/lib/pickerEntries'
import type { PickerEntry } from '../../src/renderer/lib/sessionUtils'

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    provider: 'codex',
    sessionId: 'session-1',
    slug: null,
    firstMessage: 'hello there',
    lastTimestamp: new Date(1_000).toISOString(),
    size: 1,
    cwd: '/repo/project-alpha',
    projectPath: '/repo/project-alpha',
    isWorktree: false,
    ...overrides,
  }
}

function historyEntry(m: SessionMeta): PickerEntry {
  // A fresh wrapper object every call, mirroring what dedupeHistoryEntries
  // produces on every derive pass — only `meta` carries stable identity.
  return { kind: 'history', meta: m }
}

function tab(overrides: Partial<Tab> = {}): Tab {
  return { id: 'tab-1', sessionId: 'sess-1', ...overrides } as Tab
}

/** The name is the session's, so a picker row reads it from there. */
function session(
  run: Partial<Session['run']> & { title?: string } = {},
): Session {
  const { title = 'New Tab', ...runOverrides } = run
  return {
    agentSessionId: 'agent-1',
    title,
    run: {
      provider: 'claude-code',
      workingDirectory: '/repo/project-beta',
      ...runOverrides,
    } as Session['run'],
    messages: [],
  } as Session
}

function openEntry(t: Tab, s: Session): PickerEntry {
  return { kind: 'open', tabId: t.id, tab: t, session: s }
}

describe('dedupeHistoryEntries host scoping', () => {
  test('an open tab hides only the same host\'s history row', () => {
    // WHY: dispatch-client step 1 — the same provider session id on two hosts
    // is two sessions (the same repo, cloned twice). Host A's open tab must
    // not swallow host B's history row.
    const openSession = session({ provider: 'claude-code', serverId: 'host-a' })
    const lookup = {
      tabOrder: ['tab-1'],
      tabs: { 'tab-1': tab({ sessionId: 'sess-1' }) },
      sessions: { 'sess-1': openSession },
    }
    const sameHost = meta({ provider: 'claude-code', sessionId: 'agent-1', serverId: 'host-a' })
    const otherHost = meta({ provider: 'claude-code', sessionId: 'agent-1', serverId: 'host-b' })

    const entries = dedupeHistoryEntries([sameHost, otherHost], lookup)

    expect(entries).toEqual([{ kind: 'history', meta: otherHost }])
  })
})

describe('SearchTextCache', () => {
  test('reuses the cached search text across dedupe-created wrapper objects with the same underlying meta', () => {
    const cache = new SearchTextCache()
    const longFirstMessage = 'investigate the flaky retry loop '.repeat(400)
    const m = meta({ firstMessage: longFirstMessage })

    const first = cache.get(historyEntry(m))
    const second = cache.get(historyEntry(m))

    // A cache miss would rebuild the (very long) string via a fresh template
    // literal, which would not be reference-equal to the first result.
    expect(second).toBe(first)
    expect(first).toContain('investigate the flaky retry loop')
  })

  test('invalidates when a new SessionMeta reference carries different content for the same session', () => {
    const cache = new SearchTextCache()
    const original = meta({ firstMessage: 'original content' })
    const renamed = meta({ firstMessage: 'original content', customTitle: 'Renamed session' } as any)

    const before = cache.get(historyEntry(original))
    const after = cache.get(historyEntry(renamed))

    expect(before).not.toBe(after)
    expect(after).toContain('renamed session')
  })

  test('reuses cached text for an open entry while its session title and message count are unchanged', () => {
    const cache = new SearchTextCache()
    const t = tab()
    const s = session({ title: 'Fix login bug' })

    const first = cache.get(openEntry(t, s))
    // A new wrapper object each time, same underlying tab/session.
    const second = cache.get(openEntry(t, s))

    expect(second).toBe(first)
    expect(first).toContain('fix login bug')
  })

  test('invalidates an open entry cache when the session is renamed', () => {
    const cache = new SearchTextCache()
    const t = tab()
    const s = session({ title: 'Fix login bug' })

    const before = cache.get(openEntry(t, s))
    s.title = 'Investigate crash on save'
    const after = cache.get(openEntry(t, s))

    expect(after).not.toBe(before)
    expect(after).toContain('investigate crash on save')
  })

  test('invalidates an open entry cache once a first message actually arrives', () => {
    const cache = new SearchTextCache()
    const t = tab()
    const s = session()

    const before = cache.get(openEntry(t, s))
    expect(before).not.toContain('debug the auth flow')

    s.messages.push({ id: 'm1', role: 'user', content: 'debug the auth flow' } as any)
    const after = cache.get(openEntry(t, s))

    expect(after).not.toBe(before)
    expect(after).toContain('debug the auth flow')
  })

  test('invalidates an open entry cache when its working directory changes (e.g. a worktree swap)', () => {
    const cache = new SearchTextCache()
    const t = tab()
    const s = session({ title: 'Fix login bug', workingDirectory: '/repo/project-beta' })

    const before = cache.get(openEntry(t, s))
    s.run.workingDirectory = '/repo/project-beta-worktree'
    const after = cache.get(openEntry(t, s))

    expect(after).not.toBe(before)
    expect(after).toContain('project-beta-worktree')
  })

  test('prepare() warms every entry in one empty-query pass, so a later query reuses the same cached string', () => {
    const cache = new SearchTextCache()
    const longFirstMessage = 'investigate the flaky retry loop '.repeat(400)
    const m = meta({ firstMessage: longFirstMessage })

    // Mirrors the picker's empty-query allEntries pass: nothing has been typed
    // yet, but the cache should already be warm afterward.
    cache.prepare([historyEntry(m)])
    const warmed = cache.get(historyEntry(m))
    const reusedOnQuery = cache.get(historyEntry(m))

    expect(reusedOnQuery).toBe(warmed)
    expect(warmed).toContain('investigate the flaky retry loop')
  })

  test('prepare() prunes cache records for entries no longer present, bounding growth across reopens', () => {
    const cache = new SearchTextCache()
    const stale = historyEntry(meta({ sessionId: 'stale-session' }))
    const kept = historyEntry(meta({ sessionId: 'kept-session' }))

    cache.prepare([stale, kept])
    expect(cache.size).toBe(2)

    cache.prepare([kept])
    expect(cache.size).toBe(1)
  })
})

describe('filterEntries', () => {
  test('filters entries in a single pass, matching title, first message, or byline case-insensitively', () => {
    const cache = new SearchTextCache()
    const openA = openEntry(tab({ id: 'tab-open' }), session({ title: 'Ship the release notes' }))
    const historyMatch = historyEntry(meta({ sessionId: 'h-1', firstMessage: 'Refactor the RELEASE pipeline' }))
    const historyNoMatch = historyEntry(meta({ sessionId: 'h-2', firstMessage: 'Unrelated cleanup task' }))

    const result = filterEntries([openA, historyMatch, historyNoMatch], 'release', cache)

    expect(result).toEqual([openA, historyMatch])
  })

  test('preserves the order produced by the caller instead of repartitioning open entries ahead of history', () => {
    const cache = new SearchTextCache()
    const open1 = openEntry(tab({ id: 'tab-1' }), session({ agentSessionId: 'agent-1' }))
    const newerHistory = historyEntry(meta({ sessionId: 'h-newer', lastTimestamp: new Date(3_000).toISOString() }))
    const open2 = openEntry(tab({ id: 'tab-2' }), session({ agentSessionId: 'agent-2' }))
    const olderHistory = historyEntry(meta({ sessionId: 'h-older', lastTimestamp: new Date(1_000).toISOString() }))

    // FrozenEntryOrder (the caller) already interleaves open/history newest-first
    // globally; filterEntries must not re-sort or re-partition that order.
    const result = filterEntries([open1, newerHistory, open2, olderHistory], '', cache)

    expect(result).toEqual([open1, newerHistory, open2, olderHistory])
  })
})
