import { describe, expect, test } from 'bun:test'
import { hostReadinessCopy, type HostReadinessState } from '@solus/client-core/host-readiness'
import { attentionRows, fleetMachine, routeHops, routeInUseLabel, type FleetMachineInput } from '@solus/workspace-ui/components/fleet/lib/fleet-model'

// WHY: A host that does not answer says why in the words
// every client uses, with its one fix, and its line names the route in use.

const base: FleetMachineInput = {
  serverId: 'mac',
  installationId: 'mac',
  label: 'Mac',
  isThisDevice: false,
  isCloud: false,
  hasManagedCompute: false,
  principal: 'local-owner',
  readiness: 'ready',
  routeKind: 'lan',
  sessions: 0,
  load: null,
  hasUpdate: false,
  needsSetup: false,
}
const refused: HostReadinessState = { readiness: 'refused', away: true, unreachableReason: null, refusedReason: 'auth', lastSeenAt: null }

describe('a host that does not answer', () => {
  test('says why in the shared words, with its one fix', () => {
    const machine = fleetMachine({ ...base, readiness: 'refused', readinessCopy: hostReadinessCopy(refused, 'Mac') })
    expect(machine.state).toBe('unreachable')
    expect(machine.problem).toMatchObject({ label: 'Needs pairing', action: 'pair-again' })
    expect(attentionRows([machine])).toEqual([{ kind: 'unreachable', title: 'Mac', note: 'Needs pairing', serverIds: ['mac'], fix: 'pair-again' }])
  })

  test('a host that answers, or a stopped cloud machine, has no problem words', () => {
    expect(fleetMachine({ ...base, readinessCopy: hostReadinessCopy({ ...refused, readiness: 'ready' }, 'Mac') }).problem).toBeNull()
    expect(fleetMachine({ ...base, isCloud: true, hasManagedCompute: true, managedState: 'stopped', readiness: 'unreachable', readinessCopy: hostReadinessCopy(refused, 'Mac') }).problem).toBeNull()
  })
})

describe('the route on a host line', () => {
  // The line names how this device reaches the host now, never a saved route it does not use.
  test('names the route the link is on, or tries, with how that goes', () => {
    expect(fleetMachine({ ...base, dialedRouteKind: 'tailnet' }).routeInUse).toEqual({ kind: 'tailnet', phase: 'in-use' })
    expect(fleetMachine({ ...base, readiness: 'reconnecting', dialedRouteKind: 'lan' }).routeInUse).toEqual({ kind: 'lan', phase: 'connecting' })
    expect(fleetMachine({ ...base, readiness: 'refused', dialedRouteKind: 'public' }).routeInUse).toEqual({ kind: 'public', phase: 'refused' })
  })

  test('an unreachable host, or one the link dials on no route, is not connected', () => {
    const down = fleetMachine({ ...base, readiness: 'unreachable', routeKind: 'tailnet', dialedRouteKind: 'tailnet' })
    expect(down.routeInUse).toBeNull()
    expect(routeHops(down)).toEqual(['This device', 'Not connected', 'Mac'])
    expect(routeHops(fleetMachine({ ...base, dialedRouteKind: 'tailnet' }))).toEqual(['This device', 'Tailscale', 'Mac'])
  })
})

test('the route mark names the route and how it goes, in the words of the path line', () => {
  expect(routeInUseLabel({ kind: 'tailnet', phase: 'in-use' })).toBe('Tailscale: in use')
  expect(routeInUseLabel({ kind: 'lan', phase: 'connecting' })).toBe('Local network: connecting')
  expect(routeInUseLabel({ kind: 'public', phase: 'refused' })).toBe('Internet: sign-in refused')
})
