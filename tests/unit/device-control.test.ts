import { describe, expect, test } from 'bun:test'
import { DeviceControl, USER_LEASE_MS } from '@solus/server/devices/device-control'
import { DeviceDomainError } from '@solus/server/devices/device-errors'

/**
 * Control ownership (plan 016, S01): one controller per device, only the
 * holder may mutate, and a person taking control from an agent gets it at
 * once and keeps the agent paused until an explicit resume.
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

  test('a person takes control from another person, and only the holder may mutate', () => {
    const { value } = control()
    value.acquireForUser(DEVICE, alice)
    value.acquireForUser(DEVICE, bob)
    expect(value.state(DEVICE).lease?.holder).toEqual(bob)
    expect(code(() => value.authorize(DEVICE, alice))).toBe('control_required')
    expect(code(() => value.authorize(DEVICE, bob))).toBeNull()
  })

  test('a person taking control from an agent pauses it at once', () => {
    // WHY: the person must not wait for an agent's long action; from now on
    // the agent cannot mutate until someone resumes it.
    const { value } = control()
    value.acquireForAgent(DEVICE, agentOne)
    const result = value.acquireForUser(DEVICE, alice)
    expect(result.lease.holder).toEqual(alice)
    expect(value.state(DEVICE).agentPaused).toBe(true)
    expect(code(() => value.authorize(DEVICE, agentOne))).toBe('control_required')
    expect(code(() => value.acquireForAgent(DEVICE, agentOne))).toBe('agent_paused')
  })

  test('release and expiry never resume the agent', () => {
    const clock = { now: 1_000 }
    const { value } = control(clock)
    value.acquireForAgent(DEVICE, agentOne)
    value.acquireForUser(DEVICE, alice)
    value.release(DEVICE, alice)
    expect(code(() => value.acquireForAgent(DEVICE, agentOne))).toBe('agent_paused')
    value.acquireForUser(DEVICE, alice)
    clock.now += USER_LEASE_MS + 1
    expect(value.state(DEVICE).lease).toBeNull()
    expect(value.state(DEVICE).agentPaused).toBe(true)
    expect(value.states()).toHaveLength(1)
    value.resumeAgent(DEVICE)
    expect(value.acquireForAgent(DEVICE, agentOne).holder).toEqual(agentOne)
  })

  test('a disconnected client loses control without granting it to anyone', () => {
    const { value } = control()
    value.acquireForUser(DEVICE, alice)
    value.dropClient('client-a')
    expect(value.state(DEVICE).lease).toBeNull()
  })

  test('watching never takes control', () => {
    const { value } = control()
    expect(value.state(DEVICE).lease).toBeNull()
    expect(code(() => value.authorize(DEVICE, alice))).toBe('control_required')
  })
})
