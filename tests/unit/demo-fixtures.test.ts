import { describe, expect, test } from 'bun:test'
// The fixture barrel resolves its JSON through `import.meta.glob`, which only
// exists under Vite — the files are read directly here.
import type { DemoFixtures, ReplayStep } from '../../apps/client/src/demo/fixtures/types'
import persistedTabs from '../../apps/client/src/demo/fixtures/data/persisted-tabs.json'
import diffs from '../../apps/client/src/demo/fixtures/data/diffs.json'
import tasks from '../../apps/client/src/demo/fixtures/data/tasks.json'
import replayScript from '../../apps/client/src/demo/fixtures/data/replay-script.json'
import { demoTurnRecords, turnListingResult } from '../../apps/client/src/demo/fixtures/insights'
import { answerFor, sqlSessionId, sqlWindow } from '../../apps/client/src/demo/fixtures/insights-answers'
import { defaultExploreSql, sessionTurnsSql, sqlPresets } from '@solus/workspace-ui/components/insights/lib/insights-queries'
import { DEFAULT_TIME_RANGE, resolveRange } from '@solus/workspace-ui/components/insights/lib/time-range'
import { toTurnRows } from '@solus/workspace-ui/components/insights/lib/turn-rows'

// The demo backend is the only implementation of the RPC surface that no
// integration test exercises: it runs in a page the visitor cannot report from.
// These tests hold the contracts a fixture can silently break.

const demoFixtures = {
  persistedTabs: persistedTabs as DemoFixtures['persistedTabs'],
  diffs: diffs as unknown as DemoFixtures['diffs'],
  tasks: tasks as unknown as DemoFixtures['tasks'],
  replayScript: replayScript as unknown as ReplayStep[],
}

describe('demo diff fixtures', () => {
  // The demo's diff lookup is keyed by `IpcContext.session.sessionId`, which is
  // the persisted tab's `sessionId` — not its `tabId` and not its
  // `agentSessionId`. Keying the fixture by either of the others produced no
  // error, just an empty working-tree and session diff for every tab.
  test('every diff is keyed by a persisted tab session id', () => {
    const sessionIds = new Set(demoFixtures.persistedTabs.tabs.map((tab) => tab.sessionId))
    for (const key of Object.keys(demoFixtures.diffs)) {
      expect(sessionIds).toContain(key)
    }
  })

  test('the session the replay drives has a diff to show', () => {
    const replaySessionId = demoFixtures.replayScript[0]?.sessionId
    expect(replaySessionId).toBeTruthy()
    expect(demoFixtures.diffs[replaySessionId!]?.stats.length).toBeGreaterThan(0)
  })
})

describe('demo task links', () => {
  // The task crumb in the breadcrumb and the Task card in the project panel
  // both resolve through the session's agent session id. A tab whose session is
  // linked to no task shows neither, and the demo then reads as if Solus had no
  // task system at all.
  test('every started tab is linked to a task', () => {
    const linkedSessionIds = new Set(
      Object.values(demoFixtures.tasks.sessions).flat().map((link) => link.sessionId),
    )
    const startedTabs = demoFixtures.persistedTabs.tabs.filter((tab) => tab.agentSessionId)
    expect(startedTabs.length).toBeGreaterThan(0)
    for (const tab of startedTabs) {
      expect(linkedSessionIds).toContain(tab.agentSessionId!)
    }
  })

  test('each linked task exists in the demo task list', () => {
    const taskIds = new Set(demoFixtures.tasks.list.tasks.map((task) => task.id))
    for (const taskId of Object.keys(demoFixtures.tasks.sessions)) {
      expect(taskIds).toContain(taskId)
    }
  })
})

describe('demo insights answers', () => {
  const now = Date.parse('2026-08-18T12:00:00.000Z')
  const turns = demoTurnRecords(now)

  test('the recorded turns fill the default window', () => {
    const window = resolveRange(DEFAULT_TIME_RANGE, now)
    const inWindow = turns.filter((turn) => turn.startedAt >= window.from && turn.startedAt < window.to)
    expect(inWindow.length).toBeGreaterThan(8)
    // A histogram of one status is a flat demo; the fixture carries failures.
    expect(new Set(inWindow.map((turn) => turn.status)).size).toBeGreaterThan(1)
  })

  test('the listing reads back as turn rows', () => {
    const rows = toTurnRows(turnListingResult(turns))
    expect(rows.length).toBe(turns.length)
    expect(rows[0].prompt).toBe(turns[0].prompt)
    expect(rows[0].traceId).toBe(turns[0].traceId)
  })

  // The explore statement and the session drill-in must fall through to the
  // listing, not to a rollup — a preset matcher that caught them would replace
  // the turn list with a grouped grid.
  test('the shipped explore statements resolve to the listing', () => {
    for (const sql of [defaultExploreSql(DEFAULT_TIME_RANGE), sessionTurnsSql('demo-session-ratelimit', DEFAULT_TIME_RANGE)]) {
      expect(answerFor(sql)).toBeNull()
    }
    expect(sqlSessionId(sessionTurnsSql('demo-session-ratelimit', DEFAULT_TIME_RANGE))).toBe('demo-session-ratelimit')
    expect(sqlSessionId(defaultExploreSql(DEFAULT_TIME_RANGE))).toBeNull()
  })

  test('every preset chip is answered, and each by its own rollup', () => {
    const matched = sqlPresets(DEFAULT_TIME_RANGE).map((preset) => {
      const answer = answerFor(preset.text)
      expect(answer, `no demo answer for preset ${preset.id}`).not.toBeNull()
      return answer!.id
    })
    expect(new Set(matched).size).toBe(matched.length)
  })

  test('a relative window is read off the statement it was written into', () => {
    const window = sqlWindow(defaultExploreSql({ kind: 'relative', ms: 3_600_000 }), now)
    expect(window.from).toBe(now - 3_600_000)
    expect(sqlWindow(defaultExploreSql({ kind: 'absolute', from: 10, to: 20 }), now)).toEqual({ from: 10, to: 20 })
  })
})
