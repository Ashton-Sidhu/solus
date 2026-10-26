import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HISTORY_PAGE_BYTES, HISTORY_PAGE_ROWS, type SessionLoadMessage } from '@solus/contracts/session-history'
import { loadClaudeHistoryPage } from '@solus/server/execution/agents/claude/claude-history-page'
import { parseJsonlLine } from '@solus/server/execution/agents/claude/claude-session-helpers'
import { INITIAL_HISTORY_TURNS, OLDER_HISTORY_TURNS } from '@solus/client-core/session-history-page'
import { TranscriptModel } from '../../apps/mobile/src/features/conversation/lib/transcript-model'

// WHY: a page counted only in user turns loads one long agent turn whole. A
// turn of thousands of tool calls then freezes the client when the session
// opens. Every page stops at a row and a byte budget, and the older pages
// give back the rest of the turn, row for row.

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

const at = (clock: number) => new Date(clock).toISOString()
const prompt = (text: string, clock: number) =>
  JSON.stringify({ type: 'user', timestamp: at(clock), message: { content: [{ type: 'text', text }] } }) + '\n'
const call = (id: string, clock: number) =>
  JSON.stringify({ type: 'assistant', timestamp: at(clock), message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `/repo/${id}.ts` } }] } }) + '\n'
const result = (id: string, output: string, clock: number) =>
  JSON.stringify({ type: 'user', timestamp: at(clock), message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] } }) + '\n'

/** An earlier short turn, then one turn of 900 rows: 450 calls and their results. */
async function longTurnSession(output: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'solus-history-cap-'))
  directories.push(directory)
  const file = join(directory, 'session.jsonl')
  let clock = 0
  let body = prompt('earlier', ++clock) + JSON.stringify({ type: 'assistant', timestamp: at(++clock), message: { content: [{ type: 'text', text: 'done' }] } }) + '\n'
  body += prompt('long turn', ++clock)
  for (let step = 0; step < 450; step++) body += call(`tool-${step}`, ++clock) + result(`tool-${step}`, output, ++clock)
  await writeFile(file, body)
  return file
}

async function everyRow(file: string): Promise<SessionLoadMessage[]> {
  return (await readFile(file, 'utf8')).split('\n').flatMap((line) => parseJsonlLine(line) ?? [])
}

/** Every page from the newest to the oldest, as a client reads them. */
async function allPages(file: string) {
  const pages = [await loadClaudeHistoryPage(file, INITIAL_HISTORY_TURNS)]
  while (pages.at(-1)!.before) pages.push(await loadClaudeHistoryPage(file, OLDER_HISTORY_TURNS, pages.at(-1)!.before!))
  return pages
}

test('a turn longer than the row budget opens at its newest rows, and older pages give back the rest exactly', async () => {
  const file = await longTurnSession('ok')
  const pages = await allPages(file)
  expect(pages[0].messages).toHaveLength(HISTORY_PAGE_ROWS)
  expect(pages[0].messages[0].role).not.toBe('user')
  expect(pages.flatMap((page) => page.messages.slice().reverse()).reverse()).toEqual(await everyRow(file))
})

test('a turn larger than the byte budget opens within it, and older pages give back the rest exactly', async () => {
  const output = 'x'.repeat(8 * 1024)
  const file = await longTurnSession(output)
  const pages = await allPages(file)
  const first = pages[0]
  expect(first.messages.length).toBeLessThan(HISTORY_PAGE_ROWS)
  // The page read starts at its cursor: the bytes after it are what it read.
  const { offset } = JSON.parse(first.before!) as { offset: number }
  expect((await stat(file)).size - offset).toBeLessThanOrEqual(HISTORY_PAGE_BYTES + result('tool-449', output, 0).length)
  expect(pages.flatMap((page) => page.messages.slice().reverse()).reverse()).toEqual(await everyRow(file))
})

test('mobile keeps a result whose call is on an older page, and settles the call when that page arrives', () => {
  const call = { role: 'tool', toolId: 'edit', toolName: 'Edit', toolInput: '{}', content: '', timestamp: 2 }
  const failed = { role: 'tool_result', toolResultForId: 'edit', status: 'error' as const, errorHead: 'no such file', content: '', timestamp: 3 }
  const model = TranscriptModel.fromHistory('session', { messages: [failed, { role: 'assistant', content: 'retrying', timestamp: 4 }], before: 'cursor' })
  model.prependHistory({ messages: [{ role: 'user', content: 'fix it', timestamp: 1 }, call], before: null })
  const items = model.order.map((id) => model.items.get(id))
  expect(items.map((item) => item?.kind)).toEqual(['user', 'tool', 'assistant'])
  expect(items[1]).toMatchObject({ toolId: 'edit', status: 'error', errorHead: 'no such file' })
})
