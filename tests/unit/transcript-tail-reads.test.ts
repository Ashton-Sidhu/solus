import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { startsHistoryTurn, type ProviderHistoryPage, type SessionLoadMessage } from '@solus/contracts/session-history'
import type { AgentId } from '@solus/contracts/types'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'
import { HOST_ACTOR } from '@solus/server/admission/actor'
import type { CodexTurnHistory } from '@solus/server/execution/agents/codex/codex-utils'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WHY: a provider switch carries about 16k tokens of history, and an unattended
// run reports only its last turn. Both used to parse the whole transcript, so
// their cost grew with the session. They now read pages from the end, and these
// tests count what was read, not how long it took.

let SessionHistory: typeof import('@solus/server/execution/sessions/session-history')['SessionHistory']
let PromptDispatch: typeof import('@solus/server/execution/sessions/prompt-dispatch')['PromptDispatch']
let buildHandoff: typeof import('@solus/server/execution/agents/session-handoff')['buildHandoff']
let loadClaudeHistoryPage: typeof import('@solus/server/execution/agents/claude/claude-history-page')['loadClaudeHistoryPage']
let loadClaudeFirstTurn: typeof import('@solus/server/execution/agents/claude/claude-history-page')['loadClaudeFirstTurn']
let loadCodexHistoryPage: typeof import('@solus/server/execution/agents/codex/codex-history-page')['loadCodexHistoryPage']
let HandoffCarryStore: typeof import('@solus/server/data/sessions/handoff-carry-store')['HandoffCarryStore']
let lineage: typeof import('@solus/server/data/sessions/session-lineage')

const previousDataDir = process.env.SOLUS_DATA_DIR
const root = mkdtempSync(join(tmpdir(), 'solus-tail-reads-'))
beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = join(root, 'data')
  ;({ SessionHistory } = await import('@solus/server/execution/sessions/session-history'))
  ;({ PromptDispatch } = await import('@solus/server/execution/sessions/prompt-dispatch'))
  ;({ buildHandoff } = await import('@solus/server/execution/agents/session-handoff'))
  ;({ loadClaudeHistoryPage, loadClaudeFirstTurn } = await import('@solus/server/execution/agents/claude/claude-history-page'))
  ;({ loadCodexHistoryPage } = await import('@solus/server/execution/agents/codex/codex-history-page'))
  ;({ HandoffCarryStore } = await import('@solus/server/data/sessions/handoff-carry-store'))
  lineage = await import('@solus/server/data/sessions/session-lineage')
})

afterAll(async () => {
  const { closeDb } = await import('@solus/server/db')
  closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

function claudeLine(type: 'user' | 'assistant', text: string, timestamp: number): string {
  return JSON.stringify({ type, uuid: `${type}-${timestamp}`, timestamp: new Date(timestamp).toISOString(), message: { content: [{ type: 'text', text }] } }) + '\n'
}

/** A Claude transcript of `turns` turns: "request N" and "answer N", padded. */
function claudeTranscript(name: string, turns: number, padding = 300): string {
  const file = join(root, `${name}.jsonl`)
  let text = ''
  for (let turn = 1; turn <= turns; turn++) {
    text += claudeLine('user', `request ${turn} ${'r'.repeat(padding)}`, turn * 10)
    text += claudeLine('assistant', `answer ${turn} ${'a'.repeat(padding)}`, turn * 10 + 1)
  }
  writeFileSync(file, text)
  return file
}

/** A Codex thread whose turns are listed by summary and read item by item. */
function codexThread(turnCount: number) {
  const turns: CodexTurnHistory[] = Array.from({ length: turnCount }, (_, index) => ({ id: `codex-turn-${index + 1}`, itemsView: 'summary' as const, startedAt: 1_700_000_000 + index }))
  const requestedTurns: string[] = []
  const readItems = async ({ turnId }: { turnId: string }) => {
    requestedTurns.push(turnId)
    return {
      data: [
        { turnId, item: { id: `${turnId}-answer`, type: 'agentMessage', text: `codex answer ${turnId}` } },
        { turnId, item: { id: `${turnId}-prompt`, type: 'userMessage', content: [{ type: 'text', text: `codex request ${turnId}` }] } },
      ],
      nextCursor: null,
    }
  }
  return { turns, requestedTurns, readItems }
}

interface Reader {
  claudeFiles: Map<string, string>
  codex?: ReturnType<typeof codexThread>
  /** Every page a provider returned, by thread. */
  pages: Array<{ threadId: string; turnLimit: number; turns: number }>
  /** Every read from the start of a thread, with the turns it returned. */
  firstTurns?: Array<{ threadId: string; turns: number }>
}

async function providerFirstTurn(reader: Reader, threadId: string): Promise<SessionLoadMessage[]> {
  const file = reader.claudeFiles.get(threadId)
  const messages = file
    ? await loadClaudeFirstTurn(file)
    : (await loadCodexHistoryPage(threadId, reader.codex!.turns.slice(0, 1), reader.codex!.readItems, 1)).messages
  ;(reader.firstTurns ??= []).push({ threadId, turns: messages.filter(startsHistoryTurn).length })
  return messages
}

function providerPage(reader: Reader, threadId: string, turnLimit: number, before?: string): Promise<ProviderHistoryPage> {
  const file = reader.claudeFiles.get(threadId)
  const page = file
    ? loadClaudeHistoryPage(file, turnLimit, before)
    : loadCodexHistoryPage(threadId, reader.codex!.turns, reader.codex!.readItems, turnLimit, before)
  return page.then((loaded) => {
    reader.pages.push({ threadId, turnLimit, turns: loaded.messages.filter(startsHistoryTurn).length })
    return loaded
  })
}

/** A `SessionHistory` over fixture transcripts. `loadSession` is the whole-transcript read the handoff used before. */
function historyOver(reader: Reader) {
  const runtime = {
    activeRunRequests: new Map(),
    activeSessions: new Map(),
    handoffs: { handoffCarry: new HandoffCarryStore() },
    backendFor: (_provider: AgentId) => ({
      loadSessionPage: (threadId: string, _projectPath: string | undefined, turnLimit: number, before?: string) => providerPage(reader, threadId, turnLimit, before),
      loadSession: async (threadId: string) => (await providerPage(reader, threadId, 100_000)).messages,
      loadSessionFirstTurn: (threadId: string) => providerFirstTurn(reader, threadId),
    }),
  }
  const history = new SessionHistory(runtime as unknown as SessionRuntime)
  ;(runtime as unknown as { history: typeof history }).history = history
  return { history, runtime }
}

async function handoffText(history: InstanceType<typeof SessionHistory>, provider: AgentId, threadId: string, mode: 'pages' | 'whole', historyTokens?: number): Promise<string> {
  const handoffRoot = join(root, 'handoffs')
  const handoff = await buildHandoff(threadId, '/project', {
    handoffRoot, now: () => 1, fromProvider: provider, historyTokens,
    loadPage: mode === 'pages'
      ? (id, path, turnLimit, before) => history.loadHandoffPage(provider, id, path, turnLimit, before)
      : async (id, path) => ({ messages: await history.loadSession(provider, id, path), before: null }),
    loadFirstTurn: mode === 'pages' ? (id, path) => history.loadHandoffFirstTurn(provider, id, path) : undefined,
  })
  return readFileSync(handoff.transcriptFilePath!, 'utf8')
}

const carried = (text: string) => text.match(/(?:codex )?(?:request|answer) [\w-]+/g) ?? []

describe('provider handoff reads the end of the history', () => {
  test('a long session reads only tail pages and its first turn, and carries what the whole read carries', async () => {
    const reader: Reader = { claudeFiles: new Map([['long-1', claudeTranscript('long', 200)]]), pages: [] }
    const { history } = historyOver(reader)

    const tail = await handoffText(history, 'claude-code', 'long-1', 'pages', 2_000)
    const turnsRead = reader.pages.reduce((sum, page) => sum + page.turns, 0)
    expect(reader.pages.length).toBeLessThanOrEqual(2)
    expect(turnsRead).toBeLessThanOrEqual(20)
    expect(reader.firstTurns).toEqual([{ threadId: 'long-1', turns: 1 }])

    reader.pages.length = 0
    const whole = await handoffText(history, 'claude-code', 'long-1', 'whole', 2_000)
    expect(reader.pages[0].turns).toBe(200)

    // Both keep the original request, then the same newest turns. The tail
    // numbers its turns with fewer digits, so it can hold one more item.
    const wholeItems = carried(whole)
    const recent = wholeItems.slice(1)
    expect(wholeItems[0]).toBe('request 1')
    expect(carried(tail)[0]).toBe('request 1')
    expect(carried(tail).filter((item) => item === 'request 1')).toHaveLength(1)
    expect(carried(tail).slice(-recent.length)).toEqual(recent)
    expect(carried(tail).at(-1)).toBe('answer 200')
    expect(tail).toContain('### Turn 1 — User; item 1;')
    expect(tail).toContain('The original request (Turn 1) and recent history are included')
    expect(tail).toContain('read_session with session_id "long-1"')
  })

  test('a session inside the budget gives the same text as the whole read', async () => {
    const reader: Reader = { claudeFiles: new Map([['short-1', claudeTranscript('short', 30, 20)]]), pages: [] }
    const { history } = historyOver(reader)
    const tail = await handoffText(history, 'claude-code', 'short-1', 'pages')
    expect(reader.pages.length).toBe(3)
    expect(reader.firstTurns).toBeUndefined()
    expect(tail).toBe(await handoffText(history, 'claude-code', 'short-1', 'whole'))
    expect(tail).toContain('All visible conversation items are included.')
  })

  test('a lineage inside the budget gives the same text, with each member named', async () => {
    // Claude ran first, then Codex. The lineage session id is the first thread's.
    lineage.registerSessionLineage({ sessionId: 'lineage-1', provider: 'claude-code', providerSessionId: 'lineage-1', cwd: '/project' })
    lineage.beginSessionHandoff({ sessionId: 'lineage-1', sourceProvider: 'claude-code', sourceProviderSessionId: 'lineage-1', targetProvider: 'codex', cwd: '/project' })
    lineage.completeSessionHandoff('lineage-1', 'codex', 'codex-thread-1', '/project')
    const reader: Reader = { claudeFiles: new Map([['lineage-1', claudeTranscript('lineage', 3, 20)]]), codex: codexThread(3), pages: [] }
    const { history } = historyOver(reader)

    const tail = await handoffText(history, 'codex', 'lineage-1', 'pages')
    expect(tail).toBe(await handoffText(history, 'codex', 'lineage-1', 'whole'))
    expect(tail).toContain('Assistant (claude-code)')
    expect(tail).toContain('Assistant (codex)')
    expect(tail).toContain('session codex-thread-1')
    expect(carried(tail)).toContain('request 1')
    expect(carried(tail).at(-1)).toBe('codex answer codex-turn-3')
  })

  test('a lineage whose newest member fills the budget reads only the first turn of the older member', async () => {
    lineage.registerSessionLineage({ sessionId: 'lineage-2', provider: 'codex', providerSessionId: 'lineage-2', cwd: '/project' })
    lineage.beginSessionHandoff({ sessionId: 'lineage-2', sourceProvider: 'codex', sourceProviderSessionId: 'lineage-2', targetProvider: 'claude-code', cwd: '/project' })
    lineage.completeSessionHandoff('lineage-2', 'claude-code', 'claude-thread-2', '/project')
    const codex = codexThread(50)
    const reader: Reader = { claudeFiles: new Map([['claude-thread-2', claudeTranscript('lineage-newest', 200)]]), codex, pages: [] }
    const { history } = historyOver(reader)

    const tail = await handoffText(history, 'claude-code', 'lineage-2', 'pages', 2_000)
    expect(codex.requestedTurns).toEqual(['codex-turn-1'])
    expect(reader.pages.every((page) => page.threadId === 'claude-thread-2')).toBe(true)
    expect(reader.firstTurns).toEqual([{ threadId: 'lineage-2', turns: 1 }])
    // The oldest member's request opens the handoff, labelled with its member.
    expect(carried(tail)[0]).toBe('codex request codex-turn-1')
    expect(tail).toContain('### Turn 1 — User; item 1; session lineage-2;')
    expect(carried(tail)).not.toContain('codex answer codex-turn-1')
    expect(carried(tail).at(-1)).toBe('answer 200')
  })
})

describe('the done fallback of an unattended run', () => {
  test('joins the assistant text of the last turn and reads no earlier turn', async () => {
    const file = join(root, 'unattended.jsonl')
    writeFileSync(file, claudeLine('user', 'earlier prompt', 1) + claudeLine('assistant', 'earlier answer', 2)
      + claudeLine('user', 'last prompt', 3) + claudeLine('assistant', 'First part.', 4) + claudeLine('assistant', 'Second part.', 5))
    const reader: Reader = { claudeFiles: new Map([['agent-session-1', file]]), pages: [] }
    const { history } = historyOver(reader)
    const runtime = {
      seatForTurn: async () => undefined,
      runTurn: async () => ({
        agentSessionId: Promise.resolve({ agentSessionId: 'agent-session-1' }),
        done: Promise.resolve({}),
        cancel: () => {},
      }),
      history,
    }
    const dispatch = new PromptDispatch(runtime as unknown as SessionRuntime)
    const { done } = await dispatch.startUnattendedSession({
      prompt: 'last prompt', provider: 'claude-code', modelId: null, reasoningEffort: 'medium', cwd: root,
      actor: HOST_ACTOR, startedBy: { kind: 'webhook', webhookId: 'webhook-1', deliveryId: 'delivery-1' },
    })

    expect(await done).toEqual({ output: 'First part.\n\nSecond part.' })
    expect(reader.pages).toEqual([{ threadId: 'agent-session-1', turnLimit: 1, turns: 1 }])
  })
})
