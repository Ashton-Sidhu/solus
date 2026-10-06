import { afterAll, describe, expect, test } from 'bun:test'
import type { Message } from '@solus/contracts/types'
import { artifactIsReadable, recordDocuments, recordRows } from '@solus/workspace-ui/components/session/record/lib/record-transcript'
import { SvelteRunes } from './helpers/svelte-runes'

// WHY: a session record is what a share-link guest, and a member whose runner
// is away, reads of a session. It has no tab and no workspace, and a guest's
// link reaches the session alone. It must still show everything the transcript
// itself carries — plans, artifacts, documents, how each turn ended — say so
// when a document is not the reader's to read, and page back through history
// without a gap or a duplicate as new turns arrive.

let at = 0
function message(role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  at += 1
  return { id: `m${at}`, role, content, timestamp: at, ...extra }
}

describe('what a record draws', () => {
  test('plans, artifacts, and documents draw; cards whose subject lives elsewhere do not', () => {
    const rows = recordRows([
      message('user', 'Plan it'),
      message('plan', '', { planId: 'p1' }),
      message('assistant', '', { artifact: { kind: 'html', html: '<p>hi</p>' } }),
      message('assistant', '', { workRef: { workId: 'w1', title: 'Spec', workType: 'doc' } }),
      message('assistant', '', { taskRef: { taskId: 't1', title: 'Task', url: null } }),
    ])
    const kinds = rows.flatMap((row) => (row.kind === 'item' ? [row.item.kind] : []))
    expect(kinds).toEqual(['user', 'plan', 'artifact', 'document'])
  })

  test('a failed turn ends once: the provider error is not printed again as prose', () => {
    const rows = recordRows([
      message('user', 'Do it'),
      message('assistant', 'Overloaded'),
      message('system', 'Error: Overloaded'),
    ])
    expect(rows.map((row) => row.kind === 'end' ? `end:${row.end.kind}` : row.item.kind)).toEqual(['user', 'end:failed'])
  })

  test('a stop and a turn with no reply are endings, not notices printed as text', () => {
    const stopped = recordRows([message('user', 'Go'), message('user', '[Request interrupted by user]')])
    expect(stopped.at(-1)).toMatchObject({ kind: 'end', end: { kind: 'stopped' } })
    const silent = recordRows([message('user', 'Go'), message('assistant', 'No response requested.')])
    expect(silent.at(-1)).toMatchObject({ kind: 'end', end: { kind: 'no-reply' } })
  })

  test('an activity row with no text draws nothing: it needs a tab to act on', () => {
    const rows = recordRows([message('user', 'Go'), message('system', '')])
    expect(rows.map((row) => row.kind === 'item' && row.item.kind)).toEqual(['user'])
  })
})

describe('what a record can read', () => {
  test('a document the reader has no copy of is named by the transcript and marked unreadable', () => {
    const docs = recordDocuments(
      [message('assistant', '', { workRef: { workId: 'w1', title: 'Spec', workType: 'slides', contentVersion: 3 } })],
      () => undefined,
    )
    expect(docs).toEqual([{ workId: 'w1', title: 'Spec', workType: 'slides', contentVersion: 3, isReadable: false }])
  })

  test('a document in the reader\'s works list is readable and takes its current title', () => {
    const docs = recordDocuments(
      [message('assistant', '', { workRef: { workId: 'w1', title: 'Old', workType: 'doc' } })],
      () => ({ title: 'Renamed', type: 'doc' }),
    )
    expect(docs[0]).toMatchObject({ title: 'Renamed', isReadable: true })
  })

  test('only an artifact whose HTML is in the transcript renders; an image is a file on the runner', () => {
    expect(artifactIsReadable({ kind: 'html', html: '<p>hi</p>' })).toBe(true)
    expect(artifactIsReadable({ kind: 'html' })).toBe(false)
    expect(artifactIsReadable({ kind: 'image', path: '/repo/shot.png' })).toBe(false)
  })
})

// The store runs on Svelte's real runtime with a fake cloud transcript: one
// user and one assistant message per turn, and a cursor that is the index of
// the turn a page starts at, as the mirror's row position is.
const runes = new SvelteRunes()
afterAll(() => runes.dispose())

interface FakeHost { turns: Message[][]; reads: Array<{ turnLimit: number; before?: string }> }
const host: FakeHost = { turns: [], reads: [] }
;(globalThis as unknown as { __recordHost: FakeHost }).__recordHost = host

const transcriptStub = runes.module('record-transcript-stub', `
  export async function readSessionRecordPage(_workspace, _serverId, _meta, request) {
    const host = globalThis.__recordHost
    host.reads.push({ turnLimit: request.turnLimit, before: request.before })
    const end = request.before === undefined ? host.turns.length : Number(request.before)
    const start = Math.max(0, end - request.turnLimit)
    return { messages: host.turns.slice(start, end).flat(), before: start > 0 ? String(start) : null }
  }
`)
const metaStub = runes.module('record-meta-stub', `
  export async function readSessionMeta(_serverId, sessionId) { return { sessionId } }
`)
const connectionsStub = runes.module('record-connections-stub', `
  export const serverConnections = {
    eventsFor: () => ({ subscribe: () => () => {} }),
    onStatusChange: () => () => {},
  }
`)
const { SessionRecordStore } = await import(runes.source('session-record-store',
  'packages/workspace-ui/src/contexts/sessions/session-record.store.svelte.ts', {
    './session-record-transcript': transcriptStub,
    '@solus/client-core/session-meta': metaStub,
    '@solus/client-core/server-connections': connectionsStub,
    '@solus/client-core/session-history-page': SvelteRunes.file('packages/client-core/src/session-history-page.ts'),
  })) as typeof import('@solus/workspace-ui/contexts/sessions/session-record.store.svelte')

function turn(index: number): Message[] {
  return [
    { id: `u${index}`, role: 'user', content: `prompt ${index}`, timestamp: index * 2 },
    { id: `a${index}`, role: 'assistant', content: `answer ${index}`, timestamp: index * 2 + 1 },
  ]
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((done) => setTimeout(done, 0))
}

function shownIds(store: InstanceType<typeof SessionRecordStore>): string[] {
  return [...store.olderPages.flatMap((page) => page.messages), ...(store.messages ?? [])].map((m) => m.id)
}

function allIds(): string[] {
  return host.turns.flat().map((m) => m.id)
}

describe('paging a record back through history', () => {
  test('older pages go above the newest one until the session starts, and what is shown is untouched', async () => {
    host.turns = Array.from({ length: 35 }, (_, index) => turn(index))
    host.reads = []
    const store = new SessionRecordStore({} as never, 'cloud', 's1')
    await settle()
    expect(store.messages?.length).toBe(20)
    expect(store.olderCursor).toBe('25')
    const newest = store.messages

    await store.loadOlder()
    const firstOlder = store.olderPages[0]!.messages
    expect(store.olderCursor).toBe('5')
    await store.loadOlder()
    expect(store.olderCursor).toBeNull()

    // WHY: a page is prepended, never merged — the newest page and the pages
    // already loaded keep their arrays, so nothing on screen is re-derived.
    expect(store.messages).toBe(newest)
    expect(store.olderPages[1]!.messages).toBe(firstOlder)
    expect(shownIds(store)).toEqual(allIds())
    expect(host.reads.slice(1)).toEqual([{ turnLimit: 20, before: '25' }, { turnLimit: 20, before: '5' }])
    store.dispose()
  })

  test('a new turn after paging widens the newest page, so no turn falls between the pages', async () => {
    host.turns = Array.from({ length: 35 }, (_, index) => turn(index))
    host.reads = []
    const store = new SessionRecordStore({} as never, 'cloud', 's1')
    await settle()
    await store.loadOlder()

    host.turns.push(turn(35))
    await store.load()
    await settle()

    // Turns 5 to 35, each once: the page loaded above still meets the newest one.
    expect(shownIds(store)).toEqual(host.turns.slice(5).flat().map((m) => m.id))
    expect(store.olderCursor).toBe('5')
    store.dispose()
  })

  test('without older pages a refresh follows the newest turns and moves the cursor with them', async () => {
    host.turns = Array.from({ length: 12 }, (_, index) => turn(index))
    host.reads = []
    const store = new SessionRecordStore({} as never, 'cloud', 's1')
    await settle()
    expect(store.olderCursor).toBe('2')

    host.turns.push(turn(12))
    await store.load()
    await settle()
    expect(store.olderCursor).toBe('3')
    expect(store.messages?.[0]?.id).toBe('u3')
    store.dispose()
  })
})
