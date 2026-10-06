import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { SessionMeta } from '@solus/contracts/types'
import type { BackgroundSessionTitlePorts } from '@solus/server/execution/sessions/background-session-title'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const { ensureBackgroundSessionTitle } = await import('@solus/server/execution/sessions/background-session-title')

const records = new Map<string, SessionMeta>()
const writes: Array<{ sessionId: string; title: string }> = []
const changed: string[] = []
const pins: string[] = []
const generated: string[] = []
let releaseGeneration: (() => void) | null = null

const ports: BackgroundSessionTitlePorts = {
  read: (sessionId) => records.get(sessionId) ?? null,
  save: async (sessionId, title) => {
    const record = records.get(sessionId)
    if (!record || record.customTitle) return false
    record.customTitle = title
    writes.push({ sessionId, title })
    return true
  },
  generate: async (_runtime, prompt) => {
    generated.push(prompt)
    if (releaseGeneration) await new Promise<void>((resolve) => { releaseGeneration = resolve })
    return { title: 'Short Worker Title', description: 'The requested change.' }
  },
  refresh: async (sessionId) => { changed.push(sessionId) },
  renamePin: (sessionId) => { pins.push(sessionId) },
}

function worker(provider: 'claude-code' | 'codex', sessionId: string): SessionMeta {
  return {
    sessionId,
    provider,
    cwd: '/repo',
    firstMessage: 'A long opening prompt',
    customTitle: null,
    delegation: { parentSessionId: 'parent', rootSessionId: 'parent', messageId: 'exchange', depth: 1, intent: 'delegate', createdAt: 1 },
  } as SessionMeta
}

const runtime = { seatForTurn: async () => ({}) } as never
const events = { broadcast: mock(async () => 1) } as never

beforeEach(() => {
  records.clear()
  writes.length = 0
  changed.length = 0
  pins.length = 0
  generated.length = 0
  releaseGeneration = null
  mock.clearAllMocks()
})

describe('background worker naming', () => {
  test.each(['claude-code', 'codex'] as const)('persists and announces a %s worker name', async (provider) => {
    records.set(provider, worker(provider, provider))
    expect(await ensureBackgroundSessionTitle(runtime, events, { sessionId: provider, prompt: 'Full worker brief', preferences: { autoRenameSessions: true } }, ports)).toBe('Short Worker Title')
    expect(generated).toEqual(['Full worker brief'])
    expect(writes).toEqual([{ sessionId: provider, title: 'Short Worker Title' }])
    expect(changed).toEqual([provider])
    expect(pins).toEqual([provider])
    expect((events as { broadcast: typeof mock }).broadcast).toHaveBeenCalledTimes(1)
  })

  test('respects disabled auto naming and an existing manual title', async () => {
    const disabled = worker('codex', 'disabled')
    const manual = worker('claude-code', 'manual')
    manual.customTitle = 'My Name'
    records.set('disabled', disabled)
    records.set('manual', manual)
    expect(await ensureBackgroundSessionTitle(runtime, events, { sessionId: 'disabled', preferences: { autoRenameSessions: false } }, ports)).toBeNull()
    expect(await ensureBackgroundSessionTitle(runtime, events, { sessionId: 'manual' }, ports)).toBe('My Name')
    expect(generated).toEqual([])
  })

  test('one generation serves duplicate starts; a manual edit wins the race', async () => {
    const record = worker('codex', 'race')
    records.set('race', record)
    releaseGeneration = () => {}
    const first = ensureBackgroundSessionTitle(runtime, events, { sessionId: 'race' }, ports)
    const second = ensureBackgroundSessionTitle(runtime, events, { sessionId: 'race' }, ports)
    await Promise.resolve()
    record.customTitle = 'My Manual Title'
    releaseGeneration?.()
    expect(await Promise.all([first, second])).toEqual(['My Manual Title', 'My Manual Title'])
    expect(generated).toHaveLength(1)
    expect(writes).toEqual([])
    expect(changed).toEqual([])
  })

  test('repairs an existing prompt-only worker once', async () => {
    records.set('older', worker('claude-code', 'older'))
    expect(await ensureBackgroundSessionTitle(runtime, events, { sessionId: 'older' }, ports)).toBe('Short Worker Title')
    expect(await ensureBackgroundSessionTitle(runtime, events, { sessionId: 'older' }, ports)).toBe('Short Worker Title')
    expect(generated).toHaveLength(1)
  })
})
