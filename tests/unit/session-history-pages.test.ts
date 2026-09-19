import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadClaudeHistoryPage } from '@solus/server/agents/claude/claude-history-page'
import { loadCodexHistoryPage } from '@solus/server/agents/codex/codex-history-page'
import { loadHistoryPage } from '@solus/server/sessions/history-page'
import type { CodexTurnHistory } from '@solus/server/agents/codex/codex-utils'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

function line(type: 'user' | 'assistant', text: string, timestamp: number): string {
  return JSON.stringify({ type, timestamp: new Date(timestamp).toISOString(), message: { content: [{ type: 'text', text }] } }) + '\n'
}

test('Claude pages complete turns without overlap, including block-spanning UTF-8 and live appends', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'solus-history-page-'))
  directories.push(directory)
  const file = join(directory, 'session.jsonl')
  const long = '🙂'.repeat(20000)
  await writeFile(file, line('user', 'first', 1) + line('assistant', long, 2)
    + line('user', 'second', 3) + line('assistant', 'answer', 4))
  const recent = await loadClaudeHistoryPage(file, 1)
  expect(recent.messages.map((message) => message.content)).toEqual(['second', 'answer'])
  expect(recent.before).not.toBeNull()
  await appendFile(file, line('user', 'live', 5))
  const older = await loadClaudeHistoryPage(file, 1, recent.before!)
  expect(older.messages.map((message) => message.content)).toEqual(['first', long])
  expect(older.before).toBeNull()
})

test('Claude rejects a cursor after the file is truncated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'solus-history-page-'))
  directories.push(directory)
  const file = join(directory, 'session.jsonl')
  await writeFile(file, line('user', 'first', 1) + line('assistant', 'answer', 2) + line('user', 'second', 3))
  const recent = await loadClaudeHistoryPage(file, 1)
  await writeFile(file, '')
  await expect(loadClaudeHistoryPage(file, 1, recent.before!)).rejects.toThrow('history changed')
})

test('Codex older pages request only older turns and ignore appended turns', async () => {
  const turns: CodexTurnHistory[] = [
    { id: 'older', itemsView: 'summary' }, { id: 'newer', itemsView: 'summary' },
  ]
  const requested: string[] = []
  const read = async ({ turnId }: { turnId: string }) => {
    requested.push(turnId)
    return { data: [{ turnId, item: { type: 'agentMessage', text: turnId } }], nextCursor: null }
  }
  const recent = await loadCodexHistoryPage('thread', turns, read, 1)
  expect(recent.before).toBe('newer')
  turns.push({ id: 'live', itemsView: 'summary' })
  const older = await loadCodexHistoryPage('thread', turns, read, 1, recent.before!)
  expect(requested).toEqual(['newer', 'older'])
  expect(older.messages.map((message) => message.content)).toEqual(['older'])
  expect(older.before).toBeNull()
  await expect(loadCodexHistoryPage('thread', [], read, 1, 'newer')).rejects.toThrow('history changed')
})

test('lineage paging preserves the handoff divider once and reads each segment only when reached', async () => {
  const segments = [
    { provider: 'claude-code' as const, sessionId: 'old' },
    { provider: 'codex' as const, sessionId: 'new', divider: { role: 'system', content: 'handoff', timestamp: 2 } },
  ]
  const requested: string[] = []
  const read = async (segment: typeof segments[number]) => {
    requested.push(segment.sessionId)
    return { messages: [{ role: 'user', content: segment.sessionId, timestamp: 1 }], before: null }
  }
  const recent = await loadHistoryPage('scope', segments, 1, undefined, read)
  expect(recent.messages.map((message) => message.content)).toEqual(['handoff', 'new'])
  // A later provider handoff can append a segment without invalidating an
  // older cursor whose lineage prefix is unchanged.
  segments.push({ provider: 'codex', sessionId: 'newest', divider: { role: 'system', content: 'second handoff', timestamp: 3 } })
  const older = await loadHistoryPage('scope', segments, 1, recent.before!, read)
  expect(older.messages.map((message) => message.content)).toEqual(['old'])
  expect(requested).toEqual(['new', 'old'])
  expect(older.before).toBeNull()
  await expect(loadHistoryPage('other-scope', segments, 1, recent.before!, read)).rejects.toThrow('history changed')
  segments[0].sessionId = 'replacement'
  await expect(loadHistoryPage('scope', segments, 1, recent.before!, read)).rejects.toThrow('history changed')
})
