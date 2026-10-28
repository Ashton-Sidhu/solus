import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HISTORY_PAGE_BYTES, HISTORY_PAGE_ROWS, historyPageMustCut, type SessionLoadMessage } from '@solus/contracts/session-history'
import { loadClaudeHistoryPage } from '@solus/server/execution/agents/claude/claude-history-page'
import { loadHistoryPage, type HistorySegment } from '@solus/server/execution/sessions/history-page'
import { parseJsonlLine } from '@solus/server/execution/agents/claude/claude-session-helpers'
import { INITIAL_HISTORY_TURNS, OLDER_HISTORY_TURNS } from '@solus/client-core/session-history-page'
import { TranscriptModel } from '../../apps/mobile/src/features/conversation/lib/transcript-model'

// WHY: a page cut inside a turn changes that turn on the client when the older
// page arrives: the row the reader is on is replaced and the view jumps. So a
// full page ends only at a turn start, and a long turn arrives whole. One agent
// turn of thousands of tool calls would still freeze a client that loads it
// whole, so a turn past the hard budget is cut inside, and the older pages give
// back the rest of it, row for row.

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

const at = (clock: number) => new Date(clock).toISOString()
const prompt = (text: string, clock: number) =>
  JSON.stringify({ type: 'user', timestamp: at(clock), message: { content: [{ type: 'text', text }] } }) + '\n'
const call = (id: string, clock: number) =>
  JSON.stringify({ type: 'assistant', timestamp: at(clock), message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `/repo/${id}.ts` } }] } }) + '\n'
const result = (id: string, output: string, clock: number) =>
  JSON.stringify({ type: 'user', timestamp: at(clock), message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] } }) + '\n'

/** An earlier short turn, then one turn of `steps` calls and their results. */
async function longTurnSession(output: string, steps = 450): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'solus-history-cap-'))
  directories.push(directory)
  const file = join(directory, 'session.jsonl')
  let clock = 0
  let body = prompt('earlier', ++clock) + JSON.stringify({ type: 'assistant', timestamp: at(++clock), message: { content: [{ type: 'text', text: 'done' }] } }) + '\n'
  body += prompt('long turn', ++clock)
  for (let step = 0; step < steps; step++) body += call(`tool-${step}`, ++clock) + result(`tool-${step}`, output, ++clock)
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

const returnedBytes = (messages: SessionLoadMessage[]) =>
  messages.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)), 0)

test('a turn longer than the page budget arrives whole, from its prompt', async () => {
  const file = await longTurnSession('ok')
  const pages = await allPages(file)
  expect(pages[0].messages.length).toBeGreaterThan(HISTORY_PAGE_ROWS)
  expect(pages[0].messages[0]).toMatchObject({ role: 'user', content: 'long turn' })
  expect(pages.flatMap((page) => page.messages.slice().reverse()).reverse()).toEqual(await everyRow(file))
})

test('a turn past the hard row budget opens at its newest rows, and older pages give back the rest exactly', async () => {
  const file = await longTurnSession('ok', 1100)
  const pages = await allPages(file)
  expect(historyPageMustCut(pages[0].messages.length, 0)).toBe(true)
  expect(pages[0].messages[0].role).not.toBe('user')
  expect(pages.flatMap((page) => page.messages.slice().reverse()).reverse()).toEqual(await everyRow(file))
})

test('a turn past the hard byte budget opens within it, and older pages give back the rest exactly', async () => {
  const output = 'x'.repeat(16 * 1024)
  const file = await longTurnSession(output)
  const pages = await allPages(file)
  const first = pages[0]
  expect(first.messages[0].role).not.toBe('user')
  expect(historyPageMustCut(first.messages.length, 0)).toBe(false)
  // The cut comes at the first row past the hard budget, counted on the rows returned.
  const oneRow = returnedBytes(first.messages.slice(-1))
  expect(returnedBytes(first.messages)).toBeLessThanOrEqual(4 * HISTORY_PAGE_BYTES + oneRow)
  expect(pages.flatMap((page) => page.messages.slice().reverse()).reverse()).toEqual(await everyRow(file))
})

test('stored bytes the transcript does not return do not end a page inside a turn', async () => {
  // A tool result's stored line can be far larger than its row. Counting the
  // stored bytes ended this session's pages after a few dozen rows, always
  // inside a turn.
  const file = await longTurnSession('ok')
  const padded = (await readFile(file, 'utf8')).split('\n').map((line) => {
    if (!line) return line
    const row = JSON.parse(line)
    return JSON.stringify({ ...row, toolUseResult: { stdout: 'x'.repeat(4 * 1024) } })
  }).join('\n')
  await writeFile(file, padded)
  const pages = await allPages(file)
  expect(pages[0].messages[0]).toMatchObject({ role: 'user', content: 'long turn' })
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

test('a handoff page with a few huge rows does not also read the older provider', async () => {
  // WHY: the walk over a provider handoff counted rows only, so three rows of
  // 400 KB from the new provider let it read a whole page more from the old one.
  const huge = 'x'.repeat(400 * 1024)
  const rows = {
    old: [{ role: 'user', content: 'before the switch', timestamp: 1 }, { role: 'assistant', content: huge, timestamp: 2 }],
    new: [{ role: 'user', content: 'after the switch', timestamp: 4 }, ...[5, 6, 7].map((timestamp) => ({ role: 'assistant', content: huge, timestamp }))],
  } satisfies Record<'old' | 'new', SessionLoadMessage[]>
  const divider = { role: 'system', content: 'switched to Codex', timestamp: 3 }
  const segments: HistorySegment[] = [{ provider: 'claude-code', sessionId: 'old' }, { provider: 'codex', sessionId: 'new', divider }]
  const read = async (segment: HistorySegment) => ({ messages: rows[segment.sessionId as 'old' | 'new'], before: null })
  const recent = await loadHistoryPage('scope', segments, INITIAL_HISTORY_TURNS, undefined, read)
  // The newest rows stay; the older provider waits for the next page.
  expect(recent.messages).toEqual([divider, ...rows.new])
  const older = await loadHistoryPage('scope', segments, OLDER_HISTORY_TURNS, recent.before!, read)
  expect(older).toEqual({ messages: rows.old, before: null })
})
