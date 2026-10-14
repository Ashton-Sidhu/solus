import { describe, expect, test } from 'bun:test'
import type { LiveActivityRegistration } from '@solus/contracts/live-activity'
import type { SessionStatus } from '@solus/contracts/types'
import { liveActivityReportSchema, type AgentActivityRow, type LiveActivityReport } from '@solus/contracts/uplink'
import { LiveActivityRelay } from '../../packages/server/src/host/live-activity-relay'

const row = (hostId: string, sessionId: string, phase: AgentActivityRow['phase'] = 'running'): AgentActivityRow => ({
  hostId, sessionId, projectTitle: 'solus', threadTitle: `Session ${sessionId}`, modelTitle: 'gpt-5.5',
  phase, status: phase === 'running' ? 'Working' : 'Done', updatedAt: '2026-10-13T00:00:00.000Z', deepLink: `/thread/${hostId}/${sessionId}`,
})

const registration = (generation: number, rows: AgentActivityRow[]): LiveActivityRegistration => ({
  pushToken: 'abcdef0123456789', environment: 'production', generation, hostId: 'mac',
  card: { title: 'Solus', subtitle: 'Agent work in progress', activeCount: rows.length, updatedAt: '', activities: rows },
})

function harness(options: { registered?: boolean; statuses?: { [sessionId: string]: SessionStatus } } = {}) {
  const reports: Array<{ url: string; report: LiveActivityReport }> = []
  const relay = new LiveActivityRelay({
    statusOf: (sessionId) => options.statuses?.[sessionId] ?? null,
    registration: () => options.registered === false ? null : {
      hostId: 'host_cloud', issuer: 'https://cloud.test', jwksUrl: 'https://cloud.test/jwks', directoryUrl: 'https://cloud.test', generation: 1,
    },
    credential: () => ({ hostAccessToken: async () => 'control-token' }),
    fetchImpl: async (url, init) => {
      reports.push({ url: String(url), report: liveActivityReportSchema.parse(JSON.parse(String(init?.body))) })
      return new Response(null, { status: 204 })
    },
    now: () => Date.parse('2026-10-13T01:00:00.000Z'),
  })
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

  test('a burst of statuses for one turn is one report, and a status that changes nothing is none', async () => {
    const { relay, reports } = harness()
    relay.register(registration(1, [row('mac', 'a')]))
    relay.sessionStatusChanged({ sessionId: 'a', agentSessionId: null, status: 'running' })
    await settle()
    expect(reports).toHaveLength(0)
    relay.sessionStatusChanged({ sessionId: 'x', agentSessionId: 'a', status: 'background' })
    relay.sessionStatusChanged({ sessionId: 'x', agentSessionId: 'a', status: 'completed' })
    await settle()
    expect(reports.map((r) => r.report.rows[0]!.phase)).toEqual(['completed'])
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
})
