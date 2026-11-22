import { afterEach, describe, expect, jest, test } from 'bun:test'
import type { SessionDigest } from '@solus/contracts/session-digest'
import type { NormalizedEvent } from '@solus/contracts/types'
import { DIGEST_WRITE_INTERVAL_MS, SessionDigests } from '@solus/server/execution/sessions/session-digests'

/**
 * The host that runs a session keeps its digest in the database, from the
 * session's events and checkpoints, so every reader of the session and of each
 * session above it reads what it did with no transcript (docs/plans/session-digests.md).
 */

const START = Date.parse('2026-11-21T10:00:00Z')

function harness(stored: SessionDigest | null = null) {
  let now = START
  const writes: SessionDigest[] = []
  const announced: string[] = []
  const digests = new SessionDigests({
    load: async () => stored && structuredClone(stored),
    write: async (digest) => { writes.push(structuredClone(digest)) },
    announce: (sessionId) => { announced.push(sessionId) },
    now: () => now,
  })
  return {
    digests,
    writes,
    announced,
    at: (ms: number) => { now = START + ms },
    send: (event: NormalizedEvent) => digests.observe('session-1', event),
    last: () => writes.at(-1)!,
  }
}

afterEach(() => {
  jest.useRealTimers()
})

describe('session digests', () => {
  test('a turn is written when it starts and when it settles, not for each tool call', async () => {
    // WHY: each write tells every reader of the session, and of each session
    // above it, to read the tree again; one write per tool call would flood them.
    const run = harness()
    run.send({ type: 'user_message', text: 'Fix   the\nlogin bug', clientPromptId: 'prompt-1' })
    await run.digests.settled()
    expect(run.writes).toHaveLength(1)
    expect(run.last().turns).toEqual([expect.objectContaining({ id: 'prompt-1', prompt: 'Fix the login bug', settled: false })])

    run.at(1_000)
    run.send({ type: 'tool_call', toolName: 'Read', toolId: 'tool-1', index: 0 })
    run.send({ type: 'text_chunk', text: 'thinking about it' })
    run.send({ type: 'tool_call', toolName: 'Edit', toolId: 'tool-2', index: 1 })
    await run.digests.settled()
    expect(run.writes).toHaveLength(1)

    run.at(20_000)
    run.send({ type: 'assistant_message', text: 'Fixed the login bug.\nThe token was stale.' })
    run.send({ type: 'turn_settled', turnId: 'prompt-1', outcome: 'completed', settledAt: START + 21_000 })
    await run.digests.settled()
    expect(run.writes).toHaveLength(2)
    expect(run.last().turns[0]).toMatchObject({ settled: true, startedAt: START, endedAt: START + 21_000 })
    expect(run.last().lastReply).toBe('Fixed the login bug. The token was stale.')
    expect(run.announced).toEqual(['session-1', 'session-1'])
  })

  test("tool calls are counted in 15-second buckets from the turn's start, and a sub-agent's own calls are not", async () => {
    // WHY: the timeline's bars start at the turn's start and span 15 seconds or
    // more, so buckets that start there lose nothing it shows; a sub-agent's
    // calls belong to the sub-agent.
    const run = harness()
    run.at(7_000)
    run.send({ type: 'user_message', text: 'Go' })
    run.at(8_000)
    run.send({ type: 'tool_call', toolName: 'Read', toolId: 'a', index: 0 })
    run.at(21_000)
    run.send({ type: 'tool_call', toolName: 'Read', toolId: 'b', index: 1 })
    run.send({ type: 'tool_call', toolName: 'Read', toolId: 'inner', index: 0, parentToolUseId: 'a' })
    run.at(23_000)
    run.send({ type: 'tool_call', toolName: 'Read', toolId: 'c', index: 2 })
    run.send({ type: 'turn_settled', turnId: 't', outcome: 'completed', settledAt: START + 24_000 })
    await run.digests.settled()
    expect(run.last().turns[0].toolCalls).toEqual([[START + 7_000, 2], [START + 22_000, 1]])
  })

  test('while a turn runs, its digest is written at most once in each interval', async () => {
    const run = harness()
    jest.useFakeTimers()
    run.send({ type: 'user_message', text: 'Go' })
    await run.digests.settled()
    run.send({ type: 'tool_call', toolName: 'Read', toolId: 'a', index: 0 })
    run.send({ type: 'tool_call', toolName: 'Read', toolId: 'b', index: 1 })
    await run.digests.settled()
    expect(run.writes).toHaveLength(1)
    jest.advanceTimersByTime(DIGEST_WRITE_INTERVAL_MS)
    await run.digests.settled()
    expect(run.writes).toHaveLength(2)
    expect(run.last().turns[0].toolCalls.reduce((total, [, count]) => total + count, 0)).toBe(2)
  })

  test('a sub-agent takes its own description and ends with what it came back with, on either provider', async () => {
    const run = harness()
    run.send({ type: 'user_message', text: 'Review' })
    run.send({ type: 'tool_call', toolName: 'Task', toolId: 'claude-agent', index: 0, isSubagent: true })
    run.send({ type: 'tool_call_complete', index: 0, toolId: 'claude-agent', toolInput: JSON.stringify({ description: 'Audit the auth module', prompt: 'Read every file' }) })
    // Codex names its sub-agent by the tool alone.
    run.send({ type: 'tool_call', toolName: 'spawnAgent', toolId: 'codex-agent', index: 1, toolInput: JSON.stringify({ prompt: 'Run the tests' }) })
    run.send({ type: 'tool_result', toolUseId: 'codex-agent', content: 'Launched', isAsyncLaunch: true })
    run.at(30_000)
    run.send({ type: 'tool_result', toolUseId: 'claude-agent', content: 'Found two\nissues.' })
    run.send({ type: 'turn_settled', turnId: 't', outcome: 'completed', settledAt: START + 31_000 })
    await run.digests.settled()
    expect(run.last().subagents).toEqual([
      { id: 'claude-agent', title: 'Audit the auth module', status: 'completed', startedAt: START, endedAt: START + 30_000, detail: 'Found two issues.' },
      // A background sub-agent outlives its launch and the turn, until it reports.
      { id: 'codex-agent', title: 'Run the tests', status: 'running', startedAt: START, endedAt: null, detail: '' },
    ])

    // With no turn running, the report is written at once.
    run.at(60_000)
    run.send({ type: 'subagent_report', toolUseId: 'codex-agent', text: 'All tests pass.', isError: false })
    await run.digests.settled()
    expect(run.last().subagents[1]).toMatchObject({ status: 'completed', endedAt: START + 60_000, detail: 'All tests pass.' })
  })

  test('a turn that is stopped stops the sub-agents still running in it', async () => {
    const run = harness()
    run.send({ type: 'user_message', text: 'Go' })
    run.send({ type: 'tool_call', toolName: 'Agent', toolId: 'agent-1', index: 0, isSubagent: true })
    run.send({ type: 'turn_settled', turnId: 't', outcome: 'interrupted', settledAt: START + 5_000 })
    await run.digests.settled()
    expect(run.last().subagents[0]).toMatchObject({ status: 'stopped', endedAt: START + 5_000 })
  })

  test('a checkpoint sets the change summary and the totals of the turn it was taken in', async () => {
    // WHY: a parent shows each child's changes from the child's stored digest,
    // so the summary must land on the digest, and each turn's totals on its own turn.
    const stored: SessionDigest = {
      sessionId: 'session-1',
      turns: [
        { id: 'one', startedAt: START, endedAt: START + 10_000, settled: true, prompt: 'One', toolCalls: [], changes: null },
        { id: 'two', startedAt: START + 20_000, endedAt: START + 30_000, settled: true, prompt: 'Two', toolCalls: [], changes: null },
      ],
      changes: null,
      subagents: [],
      lastReply: null,
      updatedAt: START + 30_000,
    }
    const run = harness(stored)
    const changes = { files: [{ path: 'a.ts', additions: 3, deletions: 1, status: 'M' as const }], filesChanged: 1, additions: 3, deletions: 1 }
    run.digests.checkpointed({ sessionId: 'session-1', changes, turn: { filesChanged: 1, additions: 3, deletions: 1, endedAt: START + 30_500 } })
    await run.digests.settled()
    expect(run.last().changes).toEqual(changes)
    expect(run.last().turns.map((turn) => turn.changes)).toEqual([null, { filesChanged: 1, additions: 3, deletions: 1 }])
    expect(run.announced).toEqual(['session-1'])
  })

  test('a new turn continues the stored digest of the session', async () => {
    const stored: SessionDigest = {
      sessionId: 'session-1',
      turns: [{ id: 'old', startedAt: START - 60_000, endedAt: START - 50_000, settled: true, prompt: 'Earlier', toolCalls: [], changes: null }],
      changes: null,
      subagents: [],
      lastReply: 'Done earlier.',
      updatedAt: START - 50_000,
    }
    const run = harness(stored)
    run.send({ type: 'user_message', text: 'Again', clientPromptId: 'new' })
    await run.digests.settled()
    expect(run.last().turns.map((turn) => turn.id)).toEqual(['old', 'new'])
    expect(run.last().lastReply).toBe('Done earlier.')
  })
})
