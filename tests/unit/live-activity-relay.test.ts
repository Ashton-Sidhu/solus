import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LiveActivityRegistration } from '@solus/contracts/live-activity'
import type { SessionStatus } from '@solus/contracts/types'
import { liveActivityReportSchema, type AgentActivityRow, type LiveActivityReport } from '@solus/contracts/uplink'
import { LiveActivityRelay, type LiveActivityRelayDeps } from '../../packages/server/src/host/live-activity-relay'

const row = (hostId: string, sessionId: string, phase: AgentActivityRow['phase'] = 'running'): AgentActivityRow => ({
  hostId, sessionId, projectTitle: 'solus', threadTitle: `Session ${sessionId}`, modelTitle: 'gpt-5.5',
  phase, status: phase === 'running' ? 'Working' : 'Done', updatedAt: '2026-10-13T00:00:00.000Z', deepLink: `/threads/${hostId}/${sessionId}`,
})

const registration = (generation: number, rows: AgentActivityRow[]): LiveActivityRegistration => ({
  pushToken: 'abcdef0123456789', environment: 'production', generation, hostId: 'mac',
  card: { title: 'Solus', subtitle: 'Agent work in progress', activeCount: rows.length, updatedAt: '', activities: rows },
})

const relays: LiveActivityRelay[] = []
const directories: string[] = []
afterEach(() => {
  for (const relay of relays.splice(0)) relay.stop()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function savePathForTest(): string {
  const directory = mkdtempSync(join(tmpdir(), 'live-activity-relay-'))
  directories.push(directory)
  return join(directory, 'live-activities.json')
}

function harness(options: { registered?: boolean; statuses?: { [sessionId: string]: SessionStatus }; savePath?: string; now?: () => number; schedule?: LiveActivityRelayDeps['schedule']; response?: () => Response | Promise<Response> } = {}) {
  const reports: Array<{ url: string; report: LiveActivityReport }> = []
  const relay = new LiveActivityRelay({
    statusOf: (sessionId) => options.statuses?.[sessionId] ?? null,
    registration: () => options.registered === false ? null : {
      hostId: 'host_cloud', issuer: 'https://cloud.test', jwksUrl: 'https://cloud.test/jwks', directoryUrl: 'https://cloud.test', generation: 1,
    },
    credential: () => ({ hostAccessToken: async () => 'control-token' }),
    fetchImpl: async (url, init) => {
      reports.push({ url: String(url), report: liveActivityReportSchema.parse(JSON.parse(String(init?.body))) })
      return options.response?.() ?? new Response(null, { status: 204 })
    },
    savePath: options.savePath,
    now: options.now ?? (() => Date.parse('2026-10-13T01:00:00.000Z')),
    schedule: options.schedule,
  })
  relays.push(relay)
  return { relay, reports }
}

/** Past the burst window, and the report's fetch. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 350))

describe('Live Activity relay on the host', () => {
  test('a session on the card finishing reports this host\'s rows with the card they belong to', async () => {
    const { relay, reports } = harness()
    relay.register(registration(10, [row('mac', 'a'), row('linux', 'b')]))
    relay.sessionStatusChanged({ sessionId: 'a', agentSessionId: null, status: 'completed' })
    await settle()
    expect(reports).toHaveLength(1)
    expect(reports[0]!.url).toBe('https://cloud.test/v1/hosts/host_cloud/live-activities')
    const report = reports[0]!.report
    expect(report.generation).toBe(10)
    // Only its own rows: another host's row is that host's to report.
    expect(report.rows.map((r) => [r.sessionId, r.phase, r.status])).toEqual([['a', 'completed', 'Done']])
    expect(report.card.activities).toHaveLength(2)
  })

  test('registrations reach the relay even with matching rows; unchanged statuses send nothing more', async () => {
    const clock = deadlines()
    const { relay, reports } = harness({ schedule: clock.schedule })
    relay.register(registration(1, [row('mac', 'a')]))
    await clock.next().run()
    expect(reports.map((r) => r.report.generation)).toEqual([1])
    relay.sessionStatusChanged({ sessionId: 'a', agentSessionId: null, status: 'running' })
    expect(clock.pending()).toEqual([])
    // A new phone generation must cancel the cloud's old idle deadline.
    relay.register(registration(2, [row('mac', 'a')]))
    await clock.next().run()
    expect(reports.map((r) => r.report.generation)).toEqual([1, 2])
    relay.sessionStatusChanged({ sessionId: 'x', agentSessionId: 'a', status: 'background' })
    relay.sessionStatusChanged({ sessionId: 'x', agentSessionId: 'a', status: 'completed' })
    await clock.next().run()
    expect(reports.map((r) => r.report.rows[0]!.phase)).toEqual(['running', 'running', 'completed'])
  })

  test('a card distinguishes an approval from a question when the session phase stays the same', async () => {
    const clock = deadlines()
    const { relay, reports } = harness({ schedule: clock.schedule })
    relay.register(registration(1, [row('mac', 'a')]))
    await clock.next().run()
    relay.sessionStatusChanged({ sessionId: 'a', agentSessionId: null, status: 'awaiting_input', awaitingApproval: true })
    await clock.next().run()
    relay.sessionStatusChanged({ sessionId: 'a', agentSessionId: null, status: 'awaiting_input' })
    await clock.next().run()
    expect(reports.map(({ report }) => report.rows[0]!.phase)).toEqual([
      'running', 'waiting_for_approval', 'waiting_for_input',
    ])
  })

  test('a card the phone showed with a stale status is corrected at once', async () => {
    const { relay, reports } = harness({ statuses: { a: 'completed' } })
    relay.register(registration(1, [row('mac', 'a')]))
    await settle()
    expect(reports.map((r) => r.report.rows[0]!.status)).toEqual(['Done'])
  })

  test('an older card does not replace a newer one, and a card without this host\'s rows or an unregistered token reports nothing', async () => {
    const { relay, reports } = harness()
    relay.register(registration(5, [row('mac', 'a')]))
    relay.register(registration(4, [row('mac', 'b')]))
    relay.sessionStatusChanged({ sessionId: 'b', agentSessionId: null, status: 'completed' })
    relay.register(registration(6, [row('linux', 'c')]))
    relay.sessionStatusChanged({ sessionId: 'a', agentSessionId: null, status: 'completed' })
    await settle()
    expect(reports).toHaveLength(0)
  })

  test('a host the control plane does not know keeps the card to itself', async () => {
    const { relay, reports } = harness({ registered: false })
    relay.register(registration(1, [row('mac', 'a')]))
    relay.sessionStatusChanged({ sessionId: 'a', agentSessionId: null, status: 'completed' })
    await settle()
    expect(reports).toHaveLength(0)
  })

  test('a card with a live session is reported again while nothing changes, so its stale date moves', async () => {
    const { relay, reports } = harness()
    relay.register(registration(1, [row('mac', 'a'), row('mac', 'b', 'completed')]))
    relay.reportLiveCards()
    await settle()
    expect(reports.map((r) => r.report.rows.map((reported) => reported.phase))).toEqual([['running', 'completed']])
    // Once nothing of this host is live, there is nothing to keep fresh.
    relay.sessionStatusChanged({ sessionId: 'a', agentSessionId: null, status: 'completed' })
    await settle()
    relay.reportLiveCards()
    await settle()
    expect(reports).toHaveLength(2)
  })

  test('a restarted host keeps reporting the cards it had, until they expire', async () => {
    const savePath = savePathForTest()
    let now = Date.parse('2026-10-13T01:00:00.000Z')
    const before = harness({ savePath, now: () => now })
    before.relay.register(registration(1, [row('mac', 'a')]))
    before.relay.stop()

    const after = harness({ savePath, now: () => now })
    after.relay.sessionStatusChanged({ sessionId: 'a', agentSessionId: null, status: 'completed' })
    await settle()
    expect(after.reports.map((r) => [r.report.pushToken, r.report.rows[0]!.status])).toEqual([['abcdef0123456789', 'Done']])

    now += 9 * 60 * 60_000
    const expired = harness({ savePath, now: () => now })
    expired.relay.sessionStatusChanged({ sessionId: 'a', agentSessionId: null, status: 'failed' })
    await settle()
    expect(expired.reports).toHaveLength(0)
  })

  test('an unregistered card is not reported after a restart', async () => {
    const savePath = savePathForTest()
    const before = harness({ savePath })
    before.relay.register(registration(1, [row('mac', 'a')]))
    before.relay.unregister('abcdef0123456789')
    const after = harness({ savePath })
    after.relay.reportLiveCards()
    await settle()
    expect(after.reports).toHaveLength(0)
  })
})

function deadlines() {
  const tasks: Array<{ run: () => Promise<void>; delayMs: number; cancelled: boolean }> = []
  const schedule: NonNullable<LiveActivityRelayDeps['schedule']> = (run, delayMs) => {
    const task = { run, delayMs, cancelled: false }
    tasks.push(task)
    return () => { task.cancelled = true }
  }
  const next = () => {
    const task = tasks.find((item) => !item.cancelled)
    if (!task) throw new Error('Expected a pending Live Activity report')
    task.cancelled = true
    return task
  }
  return { schedule, next, pending: () => tasks.filter((task) => !task.cancelled) }
}

describe('Live Activity delivery recovery', () => {
  test('a final result remains pending after a refusal and retries without another session event', async () => {
    const clock = deadlines()
    let status = 503
    const { relay, reports } = harness({ schedule: clock.schedule, response: () => new Response(null, { status }) })
    relay.register(registration(1, [row('mac', 'a')]))
    relay.sessionStatusChanged({ sessionId: 'a', agentSessionId: null, status: 'completed' })
    await clock.next().run()
    expect(reports[0]!.report.rows[0]!.phase).toBe('completed')
    const retry = clock.next()
    expect(retry.delayMs).toBe(30_000)
    status = 204
    await retry.run()
    expect(reports.map((report) => report.report.rows[0]!.phase)).toEqual(['completed', 'completed'])
    expect(clock.pending()).toEqual([])
  })

  test('a network failure retains the final result; unregister and stop cancel retries', async () => {
    const clock = deadlines()
    const { relay } = harness({ schedule: clock.schedule, response: () => { throw new Error('Network unavailable') } })
    relay.register(registration(1, [row('mac', 'a')]))
    relay.sessionStatusChanged({ sessionId: 'a', agentSessionId: null, status: 'completed' })
    await clock.next().run()
    relay.unregister('abcdef0123456789')
    await clock.next().run()
    expect(clock.pending()).toEqual([])
    relay.register(registration(2, [row('mac', 'b')]))
    relay.sessionStatusChanged({ sessionId: 'b', agentSessionId: null, status: 'completed' })
    await clock.next().run()
    relay.stop()
    expect(clock.pending()).toEqual([])
  })

  test('updates for one card stay in order while the previous report waits for a receipt', async () => {
    const clock = deadlines()
    let acknowledge: (response: Response) => void = () => { throw new Error('No report in flight') }
    const receipt = new Promise<Response>((resolve) => { acknowledge = resolve })
    const { relay, reports } = harness({ schedule: clock.schedule, response: () => receipt })
    relay.register(registration(1, [row('mac', 'a')]))
    relay.sessionStatusChanged({ sessionId: 'a', agentSessionId: null, status: 'awaiting_input' })
    const inFlight = clock.next().run()
    await Promise.resolve()
    relay.sessionStatusChanged({ sessionId: 'a', agentSessionId: null, status: 'completed' })
    expect(clock.pending()).toEqual([])
    acknowledge(new Response(null, { status: 204 }))
    await inFlight
    const latest = clock.next()
    expect(latest.delayMs).toBe(300)
    await latest.run()
    expect(reports.map((report) => report.report.rows[0]!.phase)).toEqual(['waiting_for_input', 'completed'])
  })

  test('a restarted host sends its saved final result without waiting for live work', async () => {
    const clock = deadlines()
    const savePath = savePathForTest()
    const before = harness({ savePath, schedule: clock.schedule, response: () => new Response(null, { status: 503 }) })
    before.relay.register(registration(1, [row('mac', 'a')]))
    before.relay.sessionStatusChanged({ sessionId: 'a', agentSessionId: null, status: 'completed' })
    await clock.next().run()
    before.relay.stop()
    const after = harness({ savePath, schedule: clock.schedule })
    await clock.next().run()
    expect(after.reports[0]!.report.rows[0]!.phase).toBe('completed')
  })
})
