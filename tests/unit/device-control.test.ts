import { describe, expect, test } from 'bun:test'
import { DeviceControl, USER_LEASE_MS } from '@solus/server/devices/device-control'
import { DeviceDomainError } from '@solus/server/devices/device-errors'

/**
 * Control ownership (plan 016, S01): one controller per device, generations
 * refuse delayed commands, and a person taking control from an agent waits
 * for the agent's in-flight mutation, then keeps the agent paused until an
 * explicit resume.
 */

const DEVICE = { deviceHostId: 'local', deviceId: 'SIM-1' }
const alice = { kind: 'user' as const, clientId: 'client-a', label: 'Alice' }
const bob = { kind: 'user' as const, clientId: 'client-b', label: 'Bob' }
const agentOne = { kind: 'agent' as const, sessionId: 'session-1', label: 'Agent in Fix login' }
const agentTwo = { kind: 'agent' as const, sessionId: 'session-2', label: 'Agent in Docs' }

function control(clock = { now: 1_000 }) {
  let changes = 0
  const value = new DeviceControl(() => { changes++ }, () => clock.now)
  return { value, clock, changes: () => changes }
}

function code(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof DeviceDomainError ? error.code : 'other'
  }
}

describe('device control', () => {
  test('two agents cannot both control one device', () => {
    // WHY: concurrent agent work must pick a separate simulator rather than
    // fight over one screen.
    const { value } = control()
    value.acquireForAgent(DEVICE, agentOne)
    expect(code(() => value.acquireForAgent(DEVICE, agentTwo))).toBe('control_busy')
    expect(value.acquireForAgent({ ...DEVICE, deviceId: 'SIM-2' }, agentTwo).holder).toEqual(agentTwo)
  })

  test('two simultaneous user requests produce one current generation', async () => {
    const { value } = control()
    const [first, second] = await Promise.all([value.acquireForUser(DEVICE, alice), value.acquireForUser(DEVICE, bob)])
    expect(first.status).toBe('granted')
    expect(second.status).toBe('granted')
    const live = value.state(DEVICE).lease!
    expect(live.holder).toEqual(bob)
    // The earlier grant is now stale and cannot mutate.
    if (first.status !== 'granted') throw new Error('unreachable')
    expect(code(() => value.begin(DEVICE, first.lease.generation, alice))).toBe('control_stale')
  })

  test('a delayed command from an old generation is refused', async () => {
    const { value } = control()
    const old = value.acquireForAgent(DEVICE, agentOne)
    await value.acquireForUser(DEVICE, alice)
    expect(code(() => value.begin(DEVICE, old.generation, agentOne))).toBe('control_stale')
    value.resumeAgent(DEVICE)
    const fresh = value.acquireForAgent(DEVICE, agentOne)
    expect(fresh.generation).toBeGreaterThan(old.generation)
    expect(code(() => value.begin(DEVICE, old.generation, agentOne))).toBe('control_stale')
  })

  test('takeover waits for the in-flight agent mutation, then grants', async () => {
    // WHY: claiming the user has control while an install is still running
    // would let two writers act at once.
    const { value } = control()
    const lease = value.acquireForAgent(DEVICE, agentOne)
    const end = value.begin(DEVICE, lease.generation, agentOne)
    let settled = false
    const takeover = value.acquireForUser(DEVICE, alice).then((result) => { settled = true; return result })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(value.state(DEVICE).agentPaused).toBe(true)
    expect(value.state(DEVICE).pendingTakeover?.clientId).toBe('client-a')
    // No new agent mutation can start while the takeover waits.
    expect(code(() => value.begin(DEVICE, lease.generation, agentOne))).toBe('agent_paused')
    end()
    const result = await takeover
    expect(result.status).toBe('granted')
    expect(value.state(DEVICE).lease?.holder).toEqual(alice)
    expect(value.state(DEVICE).pendingTakeover).toBeUndefined()
  })

  test('release and expiry never resume the agent', async () => {
    const clock = { now: 1_000 }
    const { value } = control(clock)
    value.acquireForAgent(DEVICE, agentOne)
    await value.acquireForUser(DEVICE, alice)
    value.release(DEVICE, alice)
    expect(code(() => value.acquireForAgent(DEVICE, agentOne))).toBe('agent_paused')
    await value.acquireForUser(DEVICE, alice)
    clock.now += USER_LEASE_MS + 1
    expect(value.state(DEVICE).lease).toBeNull()
    expect(value.state(DEVICE).agentPaused).toBe(true)
    expect(value.states()).toHaveLength(1)
    value.resumeAgent(DEVICE)
    expect(value.acquireForAgent(DEVICE, agentOne).holder).toEqual(agentOne)
  })

  test('a disconnected client loses control without granting it to anyone', async () => {
    const { value } = control()
    await value.acquireForUser(DEVICE, alice)
    value.dropClient('client-a')
    expect(value.state(DEVICE).lease).toBeNull()
  })

  test('watching never takes control', () => {
    const { value } = control()
    expect(value.state(DEVICE).lease).toBeNull()
    expect(code(() => value.begin(DEVICE, 1, alice))).toBe('control_required')
  })

  test('a restarted host never accepts an earlier generation', () => {
    const before = control({ now: 1_000 }).value.acquireForAgent(DEVICE, agentOne)
    const after = control({ now: 2_000 }).value
    const lease = after.acquireForAgent(DEVICE, agentOne)
    expect(lease.generation).not.toBe(before.generation)
    expect(code(() => after.begin(DEVICE, before.generation, agentOne))).toBe('control_stale')
  })

  test('forgetting a device releases a waiting takeover', async () => {
    const { value } = control()
    const lease = value.acquireForAgent(DEVICE, agentOne)
    value.begin(DEVICE, lease.generation, agentOne)
    const takeover = value.acquireForUser(DEVICE, alice)
    value.forget((target) => target.deviceId === DEVICE.deviceId)
    expect((await takeover).status).toBe('superseded')
  })
})
