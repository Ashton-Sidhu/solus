import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { classifySendFailure, SendOutbox, type OutboxRecord } from '../../src/client-core/send-outbox'
import { TransportDisconnectedError } from '../../src/client-core/ws-transport'

const previousLocalStorage = globalThis.localStorage
const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  })
})

afterEach(() => {
  if (previousLocalStorage === undefined) {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage
  } else {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: previousLocalStorage,
    })
  }
})

function entry(clientPromptId: string): Omit<OutboxRecord, 'attempts' | 'lastError'> {
  return { clientPromptId, sessionId: 'sess-1', text: `msg ${clientPromptId}`, enqueuedAt: 1 }
}

describe('durable send outbox', () => {
  test('queued work survives a dead client and drains in arrival order', async () => {
    // WHY: dispatch-client step 6 — the queue is durable, and a fresh outbox
    // instance (an app restart) reads the same records.
    const first = new SendOutbox()
    first.enqueue('host-a', entry('p1'))
    first.enqueue('host-a', entry('p2'))

    const sent: string[] = []
    const restarted = new SendOutbox()
    await restarted.drain('host-a', async (record) => void sent.push(record.clientPromptId))

    expect(sent).toEqual(['p1', 'p2'])
    expect(restarted.entriesFor('host-a')).toEqual([])
  })

  test('re-enqueueing the same clientPromptId replaces, never duplicates', () => {
    const outbox = new SendOutbox()
    outbox.enqueue('host-a', entry('p1'))
    outbox.enqueue('host-a', { ...entry('p1'), text: 'edited' })
    const records = outbox.entriesFor('host-a')
    expect(records).toHaveLength(1)
    expect(records[0].text).toBe('edited')
  })

  test('a transient failure keeps the entry queued and stops the drain', async () => {
    // WHY: the transport died under the send — the host never answered, so
    // the message must ride the next server session untouched.
    const outbox = new SendOutbox()
    outbox.enqueue('host-a', entry('p1'))
    outbox.enqueue('host-a', entry('p2'))

    await outbox.drain('host-a', async () => {
      throw new TransportDisconnectedError()
    })

    const records = outbox.entriesFor('host-a')
    expect(records.map((record) => record.clientPromptId)).toEqual(['p1', 'p2'])
    expect(records[0].lastError).toBeNull()
    expect(records[0].attempts).toBe(1)
  })

  test('a domain failure parks the entry and the queue keeps flowing', async () => {
    // WHY: the host answered "no" — that is the entry's error to show, and one
    // refused message must not dam every later one.
    const outbox = new SendOutbox()
    outbox.enqueue('host-a', entry('refused'))
    outbox.enqueue('host-a', entry('fine'))

    const sent: string[] = []
    await outbox.drain('host-a', async (record) => {
      if (record.clientPromptId === 'refused') throw new Error('session was deleted')
      sent.push(record.clientPromptId)
    })

    expect(sent).toEqual(['fine'])
    const records = outbox.entriesFor('host-a')
    expect(records).toHaveLength(1)
    expect(records[0].lastError).toBe('session was deleted')

    // The delivery actions: `send` releases the parked entry; `remove` drops it.
    outbox.retry('host-a', 'refused')
    await outbox.drain('host-a', async (record) => void sent.push(record.clientPromptId))
    expect(sent).toEqual(['fine', 'refused'])
  })

  test('classification: only a dead transport is transient', () => {
    expect(classifySendFailure(new TransportDisconnectedError())).toBe('transient')
    expect(classifySendFailure(new Error('no such session'))).toBe('domain')
  })

  test('a corrupt queue is deleted and treated as a miss; forgetting is total', () => {
    store.set('solus.sendOutbox.v1.host-a', '{not json')
    const outbox = new SendOutbox()
    expect(outbox.entriesFor('host-a')).toEqual([])
    expect(store.has('solus.sendOutbox.v1.host-a')).toBe(false)

    outbox.enqueue('host-a', entry('p1'))
    outbox.forgetHost('host-a')
    expect(outbox.entriesFor('host-a')).toEqual([])
  })
})
