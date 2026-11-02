import { afterAll, expect, mock, test } from 'bun:test'
import { appendFileSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync, closeSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { scanPlanFile } = await import('@solus/server/execution/agents/claude/claude-plan-helpers')

/**
 * plans/028 B2: the plan scanner used to read a Claude transcript from its
 * start on every flush of a streaming turn, every two seconds for a file that
 * can be 100 MB. It now goes on from where its last scan ended, keeps the
 * plans it found, and gives a pending plan the status of a tool result that
 * arrives in a later flush.
 */

const directory = mkdtempSync(join(tmpdir(), 'solus-plan-scan-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function assistantPlan(id: string, plan: string): string {
  return `${JSON.stringify({ type: 'assistant', cwd: '/work', timestamp: '2026-11-01T10:00:00.000Z', message: { content: [{ type: 'tool_use', id, name: 'ExitPlanMode', input: { plan } }] } })}\n`
}
function toolResult(id: string, content: string, isError = false): string {
  return `${JSON.stringify({ type: 'user', timestamp: '2026-11-01T10:01:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } })}\n`
}
const chatter = `${JSON.stringify({ type: 'assistant', timestamp: '2026-11-01T10:02:00.000Z', message: { content: [{ type: 'text', text: 'Working on it, this line is long enough to count.' }] } })}\n`

test('a flush with no plan tool use reads none of the earlier file; a later tool result settles a pending plan', async () => {
  const filePath = join(directory, 'thread.jsonl')
  // Padding keeps the file past the 100-byte floor below which nothing is scanned.
  writeFileSync(filePath, chatter + assistantPlan('toolu_1', '# Plan A\n\nDo the thing.'))
  const first = await scanPlanFile(filePath, 'thread', '-work', '/work')
  expect(first.map((plan) => [plan.title, plan.derivedStatus])).toEqual([['Plan A', 'pending']])

  // The bytes already scanned change under the scanner: were they read again, the title would follow.
  const rewritten = (chatter + assistantPlan('toolu_1', '# Plan B\n\nDo the thing.'))
  expect(rewritten.length).toBe(statSync(filePath).size)
  const handle = openSync(filePath, 'r+')
  writeSync(handle, rewritten, 0)
  closeSync(handle)
  appendFileSync(filePath, chatter)
  const second = await scanPlanFile(filePath, 'thread', '-work', '/work')
  expect(second.map((plan) => plan.title)).toEqual(['Plan A'])

  // The tool result comes in its own flush; the plan it answers was found by an earlier one.
  appendFileSync(filePath, toolResult('toolu_1', 'User has approved your plan.'))
  const third = await scanPlanFile(filePath, 'thread', '-work', '/work')
  expect(third.map((plan) => [plan.title, plan.derivedStatus])).toEqual([['Plan A', 'accepted']])
})

test('a line the agent is still writing waits for the next scan', async () => {
  const filePath = join(directory, 'partial.jsonl')
  const partial = assistantPlan('toolu_2', '# Second plan\n\nSteps.')
  writeFileSync(filePath, chatter + partial.slice(0, partial.length - 20))
  expect(await scanPlanFile(filePath, 'partial', '-work', '/work')).toEqual([])
  appendFileSync(filePath, partial.slice(partial.length - 20))
  expect((await scanPlanFile(filePath, 'partial', '-work', '/work')).map((plan) => plan.title)).toEqual(['Second plan'])
})

test('a file written anew is scanned from its start', async () => {
  const filePath = join(directory, 'rewritten.jsonl')
  writeFileSync(filePath, chatter + assistantPlan('toolu_3', '# Old plan\n\nSteps.') + chatter)
  expect((await scanPlanFile(filePath, 'rewritten', '-work', '/work')).map((plan) => plan.title)).toEqual(['Old plan'])
  writeFileSync(filePath, chatter + assistantPlan('toolu_4', '# New plan\n\nSteps.'))
  expect((await scanPlanFile(filePath, 'rewritten', '-work', '/work')).map((plan) => plan.title)).toEqual(['New plan'])
})
