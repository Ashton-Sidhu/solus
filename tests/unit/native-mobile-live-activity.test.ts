import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionRecord, SessionStatus } from '@solus/contracts/types'
import { agentActivityDeepLink, deriveAgentActivity } from '../../apps/mobile/src/features/live-activity/agent-activity-model'
import {
  AgentLiveActivityController,
  LIVE_ACTIVITY_STALE_AFTER_MS,
  type LiveActivityBridge,
  type LiveActivityHandle,
} from '../../apps/mobile/src/features/live-activity/agent-live-activity-controller'
import { threadKey, type SolusThreadShell } from '../../apps/mobile/src/features/threads/thread-directory'
import { parseDeepLink } from '../../apps/mobile/src/navigation/deep-links'
import type { AgentActivityProps } from '../../apps/mobile/src/widgets/AgentActivity'

const shell = (sessionId: string, fields: Partial<SessionRecord> = {}): SolusThreadShell => ({
  key: threadKey('mac', sessionId),
  hostId: 'mac',
  hostLabel: 'Mac mini',
  record: {
    sessionId, title: `prompt ${sessionId}`, customTitle: `Session ${sessionId}`, slug: null, status: 'idle',
    lastActivityAt: 1, projectPath: '/work/solus', cwd: '/work/solus', model: 'gpt-5.5', ...fields,
  } as SessionRecord,
})
const live = (entries: Array<[string, SessionStatus]>) => new Map(entries.map(([id, status]) => [threadKey('mac', id), status]))
const derive = (threads: SolusThreadShell[], status: Map<string, SessionStatus>, tracked: ReadonlySet<string> = new Set()) =>
  deriveAgentActivity({ threads, liveStatus: status, projectTitleOf: () => 'solus', tracked, now: 0 })

describe('Live Activity content (canonical session status)', () => {
  test('each live Solus status has its card phase and label', () => {
    const state = derive(
      [shell('a'), shell('b'), shell('c'), shell('d'), shell('e')],
      live([['a', 'running'], ['b', 'awaiting_input'], ['c', 'awaiting_plan'], ['d', 'rate_limited'], ['e', 'background']]),
    )
    const rows = Object.fromEntries(state.props!.activities.map((row) => [row.sessionId, [row.phase, row.status]]))
    expect(rows).toEqual({
      a: ['running', 'Working'], b: ['waiting_for_input', 'Input'], c: ['waiting_for_approval', 'Approval'],
      d: ['limited', 'Rate limited'], e: ['running', 'Background'],
    })
    expect(state.activeCount).toBe(5)
  })

  test('nothing running and nothing shown before: no card', () => {
    expect(derive([shell('a')], live([['a', 'idle']])).props).toBeNull()
  })

  test('a session the card showed stays as Done or Failed once it settles', () => {
    const first = derive([shell('a'), shell('b')], live([['a', 'running'], ['b', 'running']]))
    const after = derive([shell('a'), shell('b')], live([['a', 'completed'], ['b', 'failed']]), first.tracked)
    expect(after.activeCount).toBe(0)
    expect(after.props!.subtitle).toBe('Agent work completed')
    expect(after.props!.activities.map((row) => [row.sessionId, row.phase])).toEqual([['a', 'completed'], ['b', 'failed']])
  })

  test('rows name the session and project only, and open that session on that host', () => {
    const [row] = derive([shell('s 1', { title: 'secret prompt text' })], live([['s 1', 'running']])).props!.activities
    expect(row).toMatchObject({ threadTitle: 'Session s 1', projectTitle: 'solus', hostId: 'mac', sessionId: 's 1' })
    expect(JSON.stringify(row)).not.toContain('secret prompt text')
    expect(row!.deepLink).toBe(agentActivityDeepLink('mac', 's 1'))
    expect(parseDeepLink(`solus:/${row!.deepLink}`)).toEqual({ screen: 'Thread', params: { hostId: 'mac', sessionId: 's 1' } })
  })

  test('the card holds at most five rows', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const state = derive(ids.map((id) => shell(id)), live(ids.map((id) => [id, 'running'])))
    expect(state.props!.activities).toHaveLength(5)
    expect(state.props!.activeCount).toBe(7)
  })
})

describe('Live Activity lifecycle', () => {
  function harness(options: { existing?: number; foreground?: boolean } = {}) {
    const calls: string[] = []
    const handle = (name: string): LiveActivityHandle => ({
      update: async (props: AgentActivityProps, stale: Date) => { calls.push(`${name}:update:${props.activeCount}:${stale.getTime()}`) },
      end: async (policy, props) => { calls.push(`${name}:end:${policy}:${props?.subtitle ?? ''}`) },
    })
    const bridge: LiveActivityBridge = {
      instances: () => Array.from({ length: options.existing ?? 0 }, (_, index) => handle(`old${index}`)),
      start: (props, stale) => { calls.push(`start:${props.activeCount}:${stale.getTime()}`); return handle('new') },
    }
    const state = {
      threads: [shell('a'), shell('b')],
      status: live([]),
      enabled: true,
      foreground: options.foreground ?? true,
      ready: true,
    }
    const controller = new AgentLiveActivityController({
      bridge,
      ready: () => state.ready,
      read: () => ({ threads: state.threads, liveStatus: state.status, projectTitleOf: () => 'solus' }),
      enabled: () => state.enabled,
      foreground: () => state.foreground,
      now: () => 1_000,
    })
    return { calls, state, controller }
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  test('work starting in front starts one card with a 10-minute stale date; a repeat sends nothing', async () => {
    const { calls, state, controller } = harness()
    state.status = live([['a', 'running']])
    controller.sync()
    controller.sync()
    await flush()
    expect(calls).toEqual([`start:1:${1_000 + LIVE_ACTIVITY_STALE_AFTER_MS}`])
  })

  test('a card is not started from the background', () => {
    const { calls, state, controller } = harness({ foreground: false })
    state.status = live([['a', 'running']])
    controller.sync()
    expect(calls).toEqual([])
  })

  test('changes update the card; when all work settles it shows the outcome and ends', async () => {
    const { calls, state, controller } = harness()
    state.status = live([['a', 'running']])
    controller.sync()
    state.status = live([['a', 'running'], ['b', 'awaiting_input']])
    controller.sync()
    state.status = live([['a', 'completed'], ['b', 'completed']])
    controller.sync()
    await flush()
    expect(calls.slice(1)).toEqual([`new:update:2:${1_000 + LIVE_ACTIVITY_STALE_AFTER_MS}`, 'new:end:default:Agent work completed'])
  })

  test('turning Live Activities off ends the card at once', async () => {
    const { calls, state, controller } = harness()
    state.status = live([['a', 'running']])
    controller.sync()
    state.enabled = false
    controller.sync()
    await flush()
    expect(calls.at(-1)).toBe('new:end:immediate:')
  })

  test('after a restart the earlier card is reused, extras end, and nothing acts before the hosts answer', async () => {
    const { calls, state, controller } = harness({ existing: 2 })
    state.ready = false
    state.status = live([['a', 'running']])
    controller.sync()
    expect(calls).toEqual([])
    state.ready = true
    controller.sync()
    await flush()
    expect(calls).toEqual(['old1:end:immediate:', `old0:update:1:${1_000 + LIVE_ACTIVITY_STALE_AFTER_MS}`])
  })

  test('a card left from an earlier run with nothing known now is removed', async () => {
    const { calls, controller } = harness({ existing: 1 })
    controller.sync()
    await flush()
    expect(calls).toEqual(['old0:end:immediate:'])
  })
})

describe('deep links and native config', () => {
  test('only session links open anything', () => {
    expect(parseDeepLink('solus://thread/h%2F1/s1')).toEqual({ screen: 'Thread', params: { hostId: 'h/1', sessionId: 's1' } })
    expect(parseDeepLink('solus://settings')).toBeNull()
    expect(parseDeepLink('https://thread/a/b')).toBeNull()
  })

  test('the Live Activity extension is configured without push, with the logo plugin first', () => {
    const app = JSON.parse(readFileSync(join(import.meta.dir, '../../apps/mobile/app.json'), 'utf8'))
    const plugins = app.expo.plugins as Array<string | [string, { [key: string]: unknown }]>
    const names = plugins.map((plugin) => (typeof plugin === 'string' ? plugin : plugin[0]))
    // Same-type mods run last-registered-first: the logo plugin must come before expo-widgets.
    expect(names.indexOf('./plugins/withWidgetLogoAsset.cjs')).toBeLessThan(names.indexOf('expo-widgets'))
    const widgets = plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-widgets') as [string, { [key: string]: unknown }]
    expect(widgets[1]).toMatchObject({ groupIdentifier: 'group.sh.solus.mobile', enablePushNotifications: false, frequentUpdates: true })
  })
})
