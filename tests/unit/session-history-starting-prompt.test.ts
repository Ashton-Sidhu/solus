import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// A client that opens a session while its run is still in setup was too late
// for the prompt's live echo, and the provider has not written the prompt to
// disk yet. The first history page is the only place left to find it; without
// it the turn renders with no prompt until the reader reloads.

let SessionHistory: typeof import('@solus/server/execution/sessions/session-history')['SessionHistory']

const previousDataDir = process.env.SOLUS_DATA_DIR
const dataDir = mkdtempSync(join(tmpdir(), 'solus-starting-prompt-'))
beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ SessionHistory } = await import('@solus/server/execution/sessions/session-history'))
})

afterAll(async () => {
  const { closeDb } = await import('@solus/server/db')
  closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function historyWith(onDisk: SessionLoadMessage[], run: { prompt: string; displayPrompt?: string } | null, providerStarted: boolean) {
  const runtime = {
    activeRunRequests: new Map(run ? [['session-1', { options: run }]] : []),
    activeSessions: new Map(providerStarted ? [['session-1', {}]] : []),
    backendFor: () => ({ loadSessionPage: async () => ({ messages: onDisk.map((message) => ({ ...message })), before: null }) }),
  }
  return new SessionHistory(runtime as unknown as SessionRuntime)
}

const page = (history: InstanceType<typeof SessionHistory>) =>
  history.loadSessionPage({ sessionId: 'session-1', provider: 'claude-code', turnLimit: 10 })

const prompts = (messages: SessionLoadMessage[]) => messages.filter((message) => message.role === 'user').map((message) => message.content)

describe('the first history page of a run in setup', () => {
  test('carries the prompt the provider has not written yet', async () => {
    const loaded = await page(historyWith([], { prompt: 'internal context\nRun the diagnosis', displayPrompt: 'Run the diagnosis' }, false))
    expect(prompts(loaded.messages)).toEqual(['Run the diagnosis'])
  })

  test('follows the turns already on disk for a later prompt', async () => {
    const onDisk = [{ role: 'user', content: 'First', timestamp: 1 }, { role: 'assistant', content: 'Done', timestamp: 2 }]
    const loaded = await page(historyWith(onDisk, { prompt: 'Second' }, false))
    expect(prompts(loaded.messages)).toEqual(['First', 'Second'])
    expect(loaded.messages.at(-1)?.content).toBe('Second')
  })

  test('is not repeated once the provider has written it', async () => {
    const loaded = await page(historyWith([{ role: 'user', content: 'Run the diagnosis', timestamp: 1 }], { prompt: 'Run the diagnosis' }, false))
    expect(prompts(loaded.messages)).toEqual(['Run the diagnosis'])
  })

  test('is left to the transcript once the provider has started', async () => {
    const loaded = await page(historyWith([], { prompt: 'Run the diagnosis' }, true))
    expect(prompts(loaded.messages)).toEqual([])
  })

  test('is absent when no run is starting', async () => {
    const loaded = await page(historyWith([], null, false))
    expect(loaded.messages).toEqual([])
  })
})
