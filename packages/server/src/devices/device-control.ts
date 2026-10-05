import type {
  DeviceControlHolder,
  DeviceControlLease,
  DeviceControlResult,
  DeviceControlState,
} from '@solus/contracts/device-types'
import { DeviceDomainError } from './device-errors'

/**
 * One controller per device (plan 016, S01). Watching never takes control.
 * Every mutation names the lease generation it was issued under; an older
 * generation is refused, so a delayed command cannot act after a takeover.
 *
 * A person taking control from an agent pauses agent device actions at once
 * and waits for the agent's in-flight mutation to finish before the grant.
 * The agent stays paused until someone explicitly resumes it: releasing
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
  pendingTakeover?: { clientId: string; label: string }
  inFlight: number
  /** Resolvers waiting for in-flight mutations to drain. */
  drained: (() => void)[]
}

const slotKey = (target: DeviceControlTarget) => `${target.deviceHostId}\u0000${target.deviceId}`

export function sameHolder(a: DeviceControlHolder, b: DeviceControlHolder): boolean {
  if (a.kind === 'user' && b.kind === 'user') return a.clientId === b.clientId
  if (a.kind === 'agent' && b.kind === 'agent') return a.sessionId === b.sessionId
  return false
}

export class DeviceControl {
  private readonly slots = new Map<string, Slot>()
  /** Seeded from the clock so generations from before a host restart never match. */
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
      slot = { target: { deviceHostId: target.deviceHostId, deviceId: target.deviceId }, lease: null, agentPaused: false, inFlight: 0, drained: [] }
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
    const state: DeviceControlState = {
      ...slot.target,
      lease: lease ? { ...lease, holder: { ...lease.holder } } : null,
      agentPaused: slot.agentPaused,
    }
    if (slot.pendingTakeover) state.pendingTakeover = { ...slot.pendingTakeover }
    return state
  }

  /** Every device someone controls or whose agent actions are paused. */
  states(): DeviceControlState[] {
    const out: DeviceControlState[] = []
    for (const slot of this.slots.values()) {
      const state = this.stateOf(slot)
      if (state.lease || state.agentPaused || state.pendingTakeover) out.push(state)
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
   * immediately and the grant waits for the in-flight mutation.
   */
  async acquireForUser(target: DeviceControlTarget, holder: DeviceControlHolder & { kind: 'user' }): Promise<DeviceControlResult> {
    const slot = this.slot(target)
    const lease = this.liveLease(slot)
    if (lease && sameHolder(lease.holder, holder)) {
      lease.expiresAt = this.now() + USER_LEASE_MS
      return { status: 'granted', lease: { ...lease }, control: this.stateOf(slot) }
    }
    if (lease?.holder.kind === 'agent') {
      slot.agentPaused = true
      if (slot.inFlight > 0) {
        slot.pendingTakeover = { clientId: holder.clientId, label: holder.label }
        this.onChange()
        await new Promise<void>((resolve) => slot.drained.push(resolve))
        if (slot.pendingTakeover?.clientId === holder.clientId) delete slot.pendingTakeover
        const after = this.liveLease(slot)
        if (after?.holder.kind === 'user' && !sameHolder(after.holder, holder)) {
          return { status: 'superseded', control: this.stateOf(slot) }
        }
        if (!this.slots.has(slotKey(target))) return { status: 'superseded', control: this.state(target) }
      }
    }
    const granted = this.grant(slot, holder)
    return { status: 'granted', lease: { ...granted }, control: this.stateOf(slot) }
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

  /**
   * Begin one mutation. Throws unless `generation` is the live lease's and
   * this holder owns it. Call the returned function in `finally`.
   */
  begin(target: DeviceControlTarget, generation: number, holder: DeviceControlHolder): () => void {
    const slot = this.slots.get(slotKey(target))
    const lease = slot ? this.liveLease(slot) : null
    if (!slot || !lease) throw new DeviceDomainError('control_required', 'Take control of this device first.')
    if (lease.generation !== generation || !sameHolder(lease.holder, holder)) {
      throw new DeviceDomainError('control_stale', 'Control of this device changed. Take control again.')
    }
    if (holder.kind === 'agent' && slot.agentPaused) {
      throw new DeviceDomainError('agent_paused', 'The user took control of this device. Wait until they resume agent control.')
    }
    lease.expiresAt = this.now() + (holder.kind === 'user' ? USER_LEASE_MS : AGENT_LEASE_MS)
    slot.inFlight++
    let ended = false
    return () => {
      if (ended) return
      ended = true
      slot.inFlight--
      if (slot.inFlight === 0) for (const resolve of slot.drained.splice(0)) resolve()
    }
  }

  /** Is this generation still live? Queued work checks before each step. */
  isCurrent(target: DeviceControlTarget, generation: number): boolean {
    return this.state(target).lease?.generation === generation
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
      for (const resolve of slot.drained.splice(0)) resolve()
      this.slots.delete(key)
      changed = true
    }
    if (changed) this.onChange()
  }
}
