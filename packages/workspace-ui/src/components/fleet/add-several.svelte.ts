import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { discoveredServerUrl } from '../../contexts'
import { newCheckCode } from '../../lib/check-code'
import { messageFor } from '../servers/lib/setup-rpc'
import { pairWithApproval } from './add-machine'
import type { FoundMachine } from './lib/discover'

export type AddOutcome = { state: 'waiting' } | { state: 'added' } | { state: 'failed'; message: string }

type FoundServer = Extract<FoundMachine, { kind: 'server' }>

/** A found machine that one action adds: it runs Solus and takes an approval request. */
export function canAddTogether(machine: FoundMachine): machine is FoundServer {
  return machine.kind === 'server'
}

/**
 * Adds several found machines at once (docs/plans/host-fleet.md D8): one approval
 * request to each, all with the same check code, so the person approves each one on
 * its own machine. Each request ends on its own; a machine that fails stays
 * selected, so Add tries it again. The state of one Add page.
 */
export class AddSeveral {
  readonly selected = new SvelteSet<string>()
  readonly outcomes = new SvelteMap<string, AddOutcome>()
  /** The check code each selected machine shows while its request waits. */
  checkCode = $state<string | null>(null)
  isRunning = $state(false)
  private controller: AbortController | null = null

  toggle(key: string, isChosen: boolean): void {
    if (isChosen) this.selected.add(key)
    else this.selected.delete(key)
  }

  /** Selects every machine that is not added yet, or none when all are selected. */
  toggleAll(machines: readonly FoundMachine[]): void {
    const open = machines.filter((machine) => canAddTogether(machine) && this.outcomes.get(machine.key)?.state !== 'added')
    const isAll = open.length > 0 && open.every((machine) => this.selected.has(machine.key))
    for (const machine of open) this.toggle(machine.key, !isAll)
  }

  async add(machines: readonly FoundMachine[]): Promise<void> {
    const chosen = machines.filter((machine): machine is FoundServer => canAddTogether(machine) && this.selected.has(machine.key))
    if (this.isRunning || !chosen.length) return
    const controller = new AbortController()
    this.controller = controller
    this.isRunning = true
    // The code shows before the requests go, so the person can compare it on each machine.
    const checkCode = newCheckCode()
    this.checkCode = checkCode
    try {
      await Promise.all(chosen.map(async (machine) => {
        this.outcomes.set(machine.key, { state: 'waiting' })
        try {
          await pairWithApproval(discoveredServerUrl(machine.server), checkCode, () => {}, controller.signal)
          this.outcomes.set(machine.key, { state: 'added' })
          this.selected.delete(machine.key)
        } catch (error) {
          if (controller.signal.aborted) this.outcomes.delete(machine.key)
          else this.outcomes.set(machine.key, { state: 'failed', message: messageFor(error) })
        }
      }))
    } finally {
      if (this.controller === controller) {
        this.controller = null
        this.checkCode = null
        this.isRunning = false
      }
    }
  }

  /** Stops every request that still waits. */
  stop(): void {
    this.controller?.abort()
  }
}
