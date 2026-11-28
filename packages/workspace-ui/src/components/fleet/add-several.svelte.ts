import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { discoveredServerUrl, serversStore } from '../../contexts'
import { pairWithoutCode } from './add-machine'
import type { FoundMachine } from './lib/discover'

export type AddOutcome = { state: 'waiting' } | { state: 'added' } | { state: 'failed'; message: string }

type FoundServer = Extract<FoundMachine, { kind: 'server' }>

/** A found machine that one action adds: it runs Solus. */
export function canAddTogether(machine: FoundMachine): machine is FoundServer {
  return machine.kind === 'server'
}

/**
 * Adds several found machines at once, each in the ways that need no code and
 * nobody at the machine (`pairWithoutCode`). A machine that needs SSH or a code
 * stays selected and says so; its Connect opens its stage, which asks. The state
 * of one Add page.
 */
export class AddSeveral {
  readonly selected = new SvelteSet<string>()
  readonly outcomes = new SvelteMap<string, AddOutcome>()
  isRunning = $state(false)

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
    this.isRunning = true
    try {
      await Promise.all(chosen.map(async (machine) => {
        this.outcomes.set(machine.key, { state: 'waiting' })
        const host = await pairWithoutCode({ url: discoveredServerUrl(machine.server), installationId: machine.server.installationId, name: machine.name, onTailnet: machine.source === 'tailnet' })
        if (!host) {
          this.outcomes.set(machine.key, { state: 'failed', message: `${machine.name} needs SSH or a pairing code. Choose Connect.` })
          return
        }
        await serversStore.savePairedServer(host)
        this.outcomes.set(machine.key, { state: 'added' })
        this.selected.delete(machine.key)
      }))
    } finally {
      this.isRunning = false
    }
  }
}
