import type {
  DeviceControlHolder,
  DeviceControlLease,
  DeviceControlResult,
  DeviceControlState,
} from '@solus/contracts/device-types'
import { DeviceDomainError } from './device-errors'

/**
 * One controller per device (plan 016, S01). Watching never takes control.
 * A mutation is allowed only for the current holder. The lease generation
 * only tells a client which lease is its own; commands do not carry it.
 *
 * A person taking control from an agent pauses agent device actions and gets
 * control at once. The agent stays paused until someone explicitly resumes it: releasing
 * control, a lease expiring or a disconnect never resumes it, and never
 * grants an agent control.
 *
 * This coordinates Solus operations. It does not sandbox shell commands an
 * agent runs outside the bridge, or someone using Xcode directly.
 */

export const USER_LEASE_MS = 2 * 60_000
export const AGENT_LEASE_MS = 10 * 60_000

export interface DeviceControlTarget {
  deviceHostId: string
  deviceId: string
}

interface Slot {
  target: DeviceControlTarget
  lease: DeviceControlLease | null
  agentPaused: boolean
}

const slotKey = (target: DeviceControlTarget) => `${target.deviceHostId}\u0000${target.deviceId}`

export function sameHolder(a: DeviceControlHolder, b: DeviceControlHolder): boolean {
  if (a.kind === 'user' && b.kind === 'user') return a.clientId === b.clientId
  if (a.kind === 'agent' && b.kind === 'agent') return a.sessionId === b.sessionId
  return false
}

export class DeviceControl {
  private readonly slots = new Map<string, Slot>()
  /** Seeded from the clock so a client never mistakes a lease from before a restart for its own. */
  private nextGeneration: number

  constructor(
    private readonly onChange: () => void,
    private readonly now: () => number = Date.now,
  ) {
    this.nextGeneration = now()
  }

  private slot(target: DeviceControlTarget): Slot {
    const key = slotKey(target)
    let slot = this.slots.get(key)
    if (!slot) {
      slot = { target: { deviceHostId: target.deviceHostId, deviceId: target.deviceId }, lease: null, agentPaused: false }
      this.slots.set(key, slot)
    }
    return slot
  }

  private liveLease(slot: Slot): DeviceControlLease | null {
    if (slot.lease && slot.lease.expiresAt <= this.now()) {
      slot.lease = null
      this.onChange()
    }
    return slot.lease
  }

  private stateOf(slot: Slot): DeviceControlState {
    const lease = this.liveLease(slot)
    return {
      ...slot.target,
      lease: lease ? { ...lease, holder: { ...lease.holder } } : null,
      agentPaused: slot.agentPaused,
    }
  }

  /** Every device someone controls or whose agent actions are paused. */
  states(): DeviceControlState[] {
    const out: DeviceControlState[] = []
    for (const slot of this.slots.values()) {
      const state = this.stateOf(slot)
      if (state.lease || state.agentPaused) out.push(state)
    }
    return out
  }

  state(target: DeviceControlTarget): DeviceControlState {
    const slot = this.slots.get(slotKey(target))
    return slot ? this.stateOf(slot) : { ...target, lease: null, agentPaused: false }
  }

  private grant(slot: Slot, holder: DeviceControlHolder): DeviceControlLease {
    const lease: DeviceControlLease = {
      ...slot.target,
      holder,
      generation: ++this.nextGeneration,
      expiresAt: this.now() + (holder.kind === 'user' ? USER_LEASE_MS : AGENT_LEASE_MS),
    }
    slot.lease = lease
    this.onChange()
    return lease
  }

  /**
   * A person takes control. A free device, their own lease and another
   * person's lease are granted at once. From an agent, agent actions pause
   * and the person gets control at once.
   */
  acquireForUser(target: DeviceControlTarget, holder: DeviceControlHolder & { kind: 'user' }): DeviceControlResult {
    const slot = this.slot(target)
    const lease = this.liveLease(slot)
    if (lease && sameHolder(lease.holder, holder)) {
      lease.expiresAt = this.now() + USER_LEASE_MS
      return { lease: { ...lease }, control: this.stateOf(slot) }
    }
    if (lease?.holder.kind === 'agent') slot.agentPaused = true
    const granted = this.grant(slot, holder)
    return { lease: { ...granted }, control: this.stateOf(slot) }
  }

  /** An agent asks to mutate. Never takes a device from a person or another agent. */
  acquireForAgent(target: DeviceControlTarget, holder: DeviceControlHolder & { kind: 'agent' }): DeviceControlLease {
    const slot = this.slot(target)
    if (slot.agentPaused) {
      throw new DeviceDomainError('agent_paused', 'The user took control of this device. Wait until they resume agent control, or open another available simulator.')
    }
    const lease = this.liveLease(slot)
    if (lease && sameHolder(lease.holder, holder)) {
      lease.expiresAt = this.now() + AGENT_LEASE_MS
      return { ...lease }
    }
    if (lease) {
      throw new DeviceDomainError('control_busy', `${lease.holder.label} is controlling this device. Open another available simulator, or retry later.`)
    }
    return { ...this.grant(slot, holder) }
  }

  release(target: DeviceControlTarget, holder: DeviceControlHolder): boolean {
    const slot = this.slots.get(slotKey(target))
    const lease = slot ? this.liveLease(slot) : null
    if (!slot || !lease || !sameHolder(lease.holder, holder)) return false
    slot.lease = null
    this.onChange()
    return true
  }

  /** Resume agent device actions. Explicit only; nothing calls this on a timer. */
  resumeAgent(target: DeviceControlTarget): void {
    const slot = this.slots.get(slotKey(target))
    if (!slot || !slot.agentPaused) return
    slot.agentPaused = false
    // The person hands the device back: their lease ends with the pause.
    if (slot.lease?.holder.kind === 'user') slot.lease = null
    this.onChange()
  }

  /** Allow one mutation, and renew the lease. Throws unless this holder has control. */
  authorize(target: DeviceControlTarget, holder: DeviceControlHolder): void {
    const slot = this.slots.get(slotKey(target))
    const lease = slot ? this.liveLease(slot) : null
    if (!slot || !lease || !sameHolder(lease.holder, holder)) {
      throw new DeviceDomainError('control_required', 'Take control of this device first.')
    }
    if (holder.kind === 'agent' && slot.agentPaused) {
      throw new DeviceDomainError('agent_paused', 'The user took control of this device. Wait until they resume agent control.')
    }
    lease.expiresAt = this.now() + (holder.kind === 'user' ? USER_LEASE_MS : AGENT_LEASE_MS)
  }

  /** A client's connection expired: its leases end. Agents stay paused. */
  dropClient(clientId: string): void {
    let changed = false
    for (const slot of this.slots.values()) {
      if (slot.lease?.holder.kind === 'user' && slot.lease.holder.clientId === clientId) {
        slot.lease = null
        changed = true
      }
    }
    if (changed) this.onChange()
  }

  /** A session's agent lost access or closed the device: its leases end. */
  dropAgent(sessionId: string, target?: DeviceControlTarget): void {
    let changed = false
    for (const slot of this.slots.values()) {
      if (target && slotKey(slot.target) !== slotKey(target)) continue
      if (slot.lease?.holder.kind === 'agent' && slot.lease.holder.sessionId === sessionId) {
        slot.lease = null
        changed = true
      }
    }
    if (changed) this.onChange()
  }

  /** The device went away (shutdown, host removed): its control state ends. */
  forget(predicate: (target: DeviceControlTarget) => boolean): void {
    let changed = false
    for (const [key, slot] of this.slots) {
      if (!predicate(slot.target)) continue
      this.slots.delete(key)
      changed = true
    }
    if (changed) this.onChange()
  }
}
