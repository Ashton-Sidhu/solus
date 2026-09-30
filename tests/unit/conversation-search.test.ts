import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { SessionRecord, SessionRecordList, SessionRecordListFilter, SessionRecordSearch, SessionRecordSearchQuery } from '@solus/contracts/types'
import type { TaskCommentHit, TaskCommentSearchQuery } from '@solus/contracts/task-types'
import { solusApiId } from '@solus/contracts/uplink'

const previousState = (globalThis as unknown as { $state?: unknown }).$state
type ConversationSearchModule = typeof import(
  '@solus/workspace-ui/components/session/unified-picker/lib/conversation-search.svelte'
)
let ConversationSearch: ConversationSearchModule['ConversationSearch']
let PAGE_SIZE: ConversationSearchModule['PAGE_SIZE']
let searchServerIds: ConversationSearchModule['searchServerIds']
let RecentSessions: ConversationSearchModule['RecentSessions']
let TaskCommentSearch: ConversationSearchModule['TaskCommentSearch']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ ConversationSearch, PAGE_SIZE, searchServerIds, RecentSessions, TaskCommentSearch } = await import(
    '@solus/workspace-ui/components/session/unified-picker/lib/conversation-search.svelte'
  ))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

const SERVICE = solusApiId('org1')

function record(sessionId: string, runnerHostId: string | null = null): SessionRecord {
  return {
    sessionId, organizationId: 'local', publication: 'local', ownerUserId: null, provider: 'claude-code', projectPath: '-repo',
    projectRemote: null, runnerHostId, title: sessionId, customTitle: null, status: 'idle', model: null, reasoningEffort: null,
    parentSessionId: null, rootSessionId: null, createdAt: 1, lastActivityAt: 1, size: 0,
    cwd: '/repo', slug: null, isWorktree: false, branch: null, projectRoot: '/repo', delegation: null,
  }
}

function found(hits: Array<{ sessionId: string; ts: number; runnerHostId?: string }>, indexing = false, total = hits.length): SessionRecordSearch {
  return {
    results: hits.map(({ sessionId, ts, runnerHostId }) => ({ record: record(sessionId, runnerHostId), snippet: sessionId, ts, messageId: 7, rank: -1, additionalMatches: [] })),
    total,
    indexing,
  }
}

/** Homes answering from a table: each home's search, in the order given. */
function homes(
  answers: Record<string, (query: SessionRecordSearchQuery) => Promise<SessionRecordSearch>>,
  options: { connectedRunners?: Record<string, string> } = {},
) {
  return {
    searchServerIds: () => Object.keys(answers),
    apiFor: (serverId: string) => ({
      sessionRecordSearch: (query: SessionRecordSearchQuery) => answers[serverId]!(query),
    }),
    connectedRunnerFor: (runnerHostId: string) => options.connectedRunners?.[runnerHostId] ?? null,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('which homes a search reads', () => {
  test('this machine, then the person\'s other machines, then the workspace service; never an organization\'s machine', () => {
    // WHY: an organization's sessions are read from its workspace service,
    // which answers while the machine that ran them is off. Asking that machine
    // too would list every one of them twice.
    const saved = [
      { id: 'personal-vm', uplink: { hostId: 'h-personal', directoryUrl: 'x', kind: 'personal' as const } },
      { id: 'org-vm', uplink: { hostId: 'h-org', directoryUrl: 'x', kind: 'managed' as const } },
    ]
    expect(searchServerIds([SERVICE, 'org-vm', 'personal-vm', 'local'], 'local', saved)).toEqual(['local', 'personal-vm', SERVICE])
    // On web there is no machine of the client's own.
    expect(searchServerIds([SERVICE, 'personal-vm'], null, saved)).toEqual(['personal-vm', SERVICE])
  })
})

describe('ConversationSearch', () => {
  test('a project scope reaches each host as its own checkout, and skips a host without one', async () => {
    // WHY: docs/plans/project-model.md §1 — one repository cloned at
    // /Users/me/web and /home/me/web is one project. Sending one path to every
    // host missed the second clone and matched unrelated folders at that path.
    const requests: Array<{ serverId: string; projectRoot: string | undefined }> = []
    const answer = (serverId: string) => async (query: SessionRecordSearchQuery) => {
      requests.push({ serverId, projectRoot: query.projectRoot })
      return found([])
    }
    const hosts = homes({ laptop: answer('laptop'), linux: answer('linux'), 'scratch-box': answer('scratch-box') })
    const checkouts: Record<string, string> = { laptop: '/Users/me/web', linux: '/home/me/web' }
    const search = new ConversationSearch(hosts, 0, (serverId) => checkouts[serverId] ?? null)
    search.search('deploy', '/Users/me/web')
    await settle()

    expect(requests).toEqual([
      { serverId: 'laptop', projectRoot: '/Users/me/web' },
      { serverId: 'linux', projectRoot: '/home/me/web' },
    ])
  })

  test('asks every home, stamps each hit with its host, and orders by hit date', async () => {
    const requests: Array<{ serverId: string; query: SessionRecordSearchQuery }> = []
    const hosts = homes({
      local: async (query) => { requests.push({ serverId: 'local', query }); return found([{ sessionId: 'old', ts: 1 }, { sessionId: 'newest', ts: 9 }]) },
      laptop: async (query) => { requests.push({ serverId: 'laptop', query }); return found([{ sessionId: 'mid', ts: 5 }]) },
    })
    const search = new ConversationSearch(hosts, 0)
    search.search('rate limit', '/repo')
    expect(search.loading).toBe(true)
    await settle()

    expect(requests.map((entry) => entry.serverId)).toEqual(['local', 'laptop'])
    // The first page of each home, every word a prefix on the host.
    expect(requests[0]!.query).toMatchObject({ query: 'rate limit', projectRoot: '/repo', offset: 0, limit: PAGE_SIZE, namesOnly: false })
    expect(search.results.map((result) => result.session.sessionId)).toEqual(['newest', 'mid', 'old'])
    expect(search.results.map((result) => result.session.serverId)).toEqual(['local', 'laptop', 'local'])
    // The record's working directory survives the trip, so a hit can be resumed.
    expect(search.results[0]!.session.cwd).toBe('/repo')
    expect(search.loading).toBe(false)
    search.search('different query', '/repo')
    expect(search.results).toEqual([])
    expect(search.total).toBe(0)
    search.reset()
  })

  test('an organization session opens on its runner while the runner is connected', async () => {
    // WHY: the service holds the record and the mirrored transcript; the
    // runner can resume the session. A hit's message id is a position in the
    // service's copy, so on the runner the preview opens on the ends, not on
    // some other message of the runner's index.
    const hosts = homes(
      { [SERVICE]: async () => found([{ sessionId: 'live', ts: 2, runnerHostId: 'h-up' }, { sessionId: 'parked', ts: 1, runnerHostId: 'h-down' }]) },
      { connectedRunners: { 'h-up': 'org-vm' } },
    )
    const search = new ConversationSearch(hosts, 0)
    search.search('canary', null)
    await settle()

    const live = search.results.find((result) => result.session.sessionId === 'live')!
    const parked = search.results.find((result) => result.session.sessionId === 'parked')!
    expect(live.session.serverId).toBe('org-vm')
    expect(live.messageId).toBe(-1)
    // Nothing connected holds it: the row is the service's record, read-only.
    expect(parked.session.serverId).toBe(SERVICE)
    expect(parked.messageId).toBe(7)
  })

  test('a home still reading its sessions for the first time marks the answer as incomplete', async () => {
    // WHY: on first launch a machine indexes its transcripts. Its hits are real
    // but not all of them, and "no conversations match" would be a false answer.
    const hosts = homes({ local: async () => found([], true), [SERVICE]: async () => found([{ sessionId: 'x', ts: 1 }]) })
    const search = new ConversationSearch(hosts, 0)
    search.search('word', null)
    await settle()
    expect(search.indexing).toBe(true)
    search.search('', null)
    expect(search.indexing).toBe(false)
  })

  test('a reply to a query the user has left is dropped', async () => {
    // WHY: hosts answer at different speeds. Hits for "alpha" landing after
    // the box says "beta" would list sessions that mention words no longer
    // in the query.
    let release: (() => void) | null = null
    const hosts = homes({
      local: async (query) => {
        if (query.query === 'alpha') {
          await new Promise<void>((resolve) => (release = resolve))
          return found([{ sessionId: 'alpha-hit', ts: 1 }])
        }
        return found([{ sessionId: 'beta-hit', ts: 1 }])
      },
    })
    const search = new ConversationSearch(hosts, 0)
    search.search('alpha', null)
    await settle()
    search.search('beta', null)
    await settle()
    release!()
    await settle()
    expect(search.results.map((result) => result.session.sessionId)).toEqual(['beta-hit'])
  })

  test('a host that fails contributes nothing and does not hide the others', async () => {
    const hosts = homes({
      broken: async () => { throw new Error('offline') },
      local: async () => found([{ sessionId: 'found', ts: 1 }]),
    })
    const search = new ConversationSearch(hosts, 0)
    search.search('anything', null)
    await settle()
    expect(search.results.map((result) => result.session.sessionId)).toEqual(['found'])
    expect(search.loading).toBe(false)
  })

  test('every match is reachable: the next page is read from the homes that have more', async () => {
    // WHY: the picker lists every session that matches (unified-search.md §6).
    // It knows the whole count from the first answer, and reads the rest a page
    // at a time from the homes that still hold some.
    const many = Array.from({ length: PAGE_SIZE + 15 }, (_, index) => ({ sessionId: `s-${index}`, ts: index }))
    const offsets: Array<{ serverId: string; offset: number | undefined }> = []
    const hosts = homes({
      many: async (query) => {
        offsets.push({ serverId: 'many', offset: query.offset })
        const start = query.offset ?? 0
        return found(many.slice(start, start + (query.limit ?? PAGE_SIZE)), false, many.length)
      },
      sparse: async (query) => {
        offsets.push({ serverId: 'sparse', offset: query.offset })
        return found([{ sessionId: 'one', ts: 1 }])
      },
    })
    const search = new ConversationSearch(hosts, 0)
    search.search('word', null)
    await settle()
    expect(search.results).toHaveLength(PAGE_SIZE + 1)
    expect([search.total, search.remaining]).toEqual([PAGE_SIZE + 16, 15])
    await search.loadMore()
    expect(search.results).toHaveLength(PAGE_SIZE + 16)
    expect(search.remaining).toBe(0)
    expect(offsets).toEqual([{ serverId: 'many', offset: 0 }, { serverId: 'sparse', offset: 0 }, { serverId: 'many', offset: PAGE_SIZE }])
    search.search('', null)
    expect([search.total, search.remaining]).toEqual([0, 0])
  })

  test('names only and the filters reach every home', async () => {
    // WHY: "Keywords in names only" still finds sessions, by their names
    // (unified-search.md §8), and a filter narrows the hosts' answer so its
    // count is right.
    const requests: SessionRecordSearchQuery[] = []
    const search = new ConversationSearch(homes({ local: async (query) => { requests.push(query); return found([]) } }), 0)
    search.search('word', null, { namesOnly: true, activeSince: 5, provider: 'codex' })
    await settle()
    expect(requests[0]).toMatchObject({ namesOnly: true, activeSince: 5, provider: 'codex' })
  })

  test('clearing the query clears the hits at once, without asking a host', async () => {
    let asked = 0
    const hosts = homes({ local: async () => { asked += 1; return found([{ sessionId: 'found', ts: 1 }]) } })
    const search = new ConversationSearch(hosts, 0)
    search.search('word', null)
    await settle()
    expect(search.results).toHaveLength(1)
    search.search('  ', null)
    expect(search.results).toEqual([])
    expect(search.loading).toBe(false)
    await settle()
    expect(asked).toBe(1)
  })

  test('a single character asks no host: it hits nearly every message, and names still match it', async () => {
    // WHY: the first keystroke made every host rank and cut passages for most
    // of its index, the costliest query a picker sends, for passages that say
    // nothing. The picker's own name pass still answers one letter.
    let asked = 0
    const hosts = homes({ local: async () => { asked += 1; return found([{ sessionId: 'found', ts: 1 }]) } })
    const search = new ConversationSearch(hosts, 0)
    search.search(' s ', null)
    expect(search.loading).toBe(false)
    await settle()
    expect(asked).toBe(0)
    search.search('se', null)
    await settle()
    expect(asked).toBe(1)
    expect(search.results).toHaveLength(1)
  })
})

describe('RecentSessions', () => {
  function listing(answers: Record<string, (filter: SessionRecordListFilter) => Promise<SessionRecordList>>, connectedRunners: Record<string, string> = {}) {
    return {
      searchServerIds: () => Object.keys(answers),
      apiFor: (serverId: string) => ({ sessionRecordList: (filter?: SessionRecordListFilter) => answers[serverId]!(filter ?? {}) }),
      connectedRunnerFor: (runnerHostId: string) => connectedRunners[runnerHostId] ?? null,
    }
  }

  test('reads each home\'s own checkout, stamps each session with its host, and skips a failed home', async () => {
    // WHY: the picker lists these beside tasks with an empty box; a session
    // must open on the host that holds it, and one host down must not empty
    // the list.
    const filters: Array<{ serverId: string; filter: SessionRecordListFilter }> = []
    const answer = (serverId: string, ids: string[]) => async (filter: SessionRecordListFilter) => {
      filters.push({ serverId, filter })
      return { records: ids.map((id) => record(id)), indexing: false }
    }
    const recent = new RecentSessions(
      listing({
        laptop: answer('laptop', ['a']),
        linux: answer('linux', ['b']),
        broken: async () => { throw new Error('offline') },
        'scratch-box': answer('scratch-box', ['never']),
      }),
      (serverId) => ({ laptop: '/Users/me/web', linux: '/home/me/web', broken: '/x' } as Record<string, string>)[serverId] ?? null,
    )
    await recent.load('/Users/me/web')

    expect(filters.map(({ serverId, filter }) => [serverId, filter.projectPath, filter.includeWorktrees])).toEqual([
      ['laptop', '/Users/me/web', true],
      ['linux', '/home/me/web', true],
    ])
    expect(recent.sessions.map((meta) => [meta.sessionId, meta.serverId])).toEqual([['a', 'laptop'], ['b', 'linux']])
    expect(recent.loading).toBe(false)
  })

  test('an organization session opens on its runner while the runner is connected', async () => {
    const recent = new RecentSessions(listing(
      { [SERVICE]: async () => ({ records: [record('live', 'h-up'), record('parked', 'h-down')], indexing: false }) },
      { 'h-up': 'org-vm' },
    ))
    await recent.load(null)
    expect(recent.sessions.map((meta) => meta.serverId)).toEqual(['org-vm', SERVICE])
  })

  test('a home that fails, or that the scope passes over, is reported rather than read as no sessions', async () => {
    // WHY: "No sessions yet" over a host that did not answer is a lie. The
    // picker says why the list is empty.
    const failing = new RecentSessions(listing({ local: async () => { throw new Error('HTTP 401') } }), () => undefined)
    await failing.load('/repo')
    expect([failing.error, failing.asked]).toEqual(['HTTP 401', 1])
    const passed = new RecentSessions(listing({ local: async () => ({ records: [record('never')], indexing: false }) }), () => null)
    await passed.load('/repo')
    expect([passed.sessions, passed.asked, passed.passedOver, passed.error]).toEqual([[], 1, 1, null])
  })

  test('a reply to an earlier load is dropped', async () => {
    let release: (list: SessionRecordList) => void = () => {}
    const recent = new RecentSessions(listing({
      local: (filter) => filter.projectPath === '/old'
        ? new Promise((resolve) => { release = resolve })
        : Promise.resolve({ records: [record('current')], indexing: false }),
    }), () => undefined)
    const stale = recent.load('/old')
    await recent.load('/current')
    release({ records: [record('stale')], indexing: false })
    await stale
    expect(recent.sessions.map((meta) => meta.sessionId)).toEqual(['current'])
  })
})

describe('TaskCommentSearch', () => {
  test('gathers each home\'s comment hits by task, and drops a reply to a query the user left', async () => {
    // WHY: a task is found by its discussion as a session is by its messages
    // (unified-search.md §7). A reply that lands after the box changed must not
    // mark tasks for words no longer in it.
    const replies: Array<(hits: TaskCommentHit[]) => void> = []
    const search = new TaskCommentSearch({
      serverIds: () => ['local', 'laptop'],
      apiFor: (serverId) => ({
        tasksSearchComments: (query: TaskCommentSearchQuery) => serverId === 'laptop' && query.query === 'first'
          ? new Promise<TaskCommentHit[]>((resolve) => replies.push(resolve))
          : Promise.resolve([{ taskId: `${serverId}-${query.query}`, commentId: 'c', snippet: query.query, createdAt: 1 }]),
      }),
    }, 0)
    search.search('first', '/repo')
    await settle()
    search.search('second', null)
    await settle()
    replies[0]!([{ taskId: 'stale', commentId: 'c', snippet: 'first', createdAt: 1 }])
    await settle()
    expect([...search.passages.keys()].sort()).toEqual(['laptop-second', 'local-second'])
    search.search('x', null)
    expect(search.passages.size).toBe(0)
  })
})
