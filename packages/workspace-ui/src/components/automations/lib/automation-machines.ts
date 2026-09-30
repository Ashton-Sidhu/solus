import type { SavedServerUplink } from '@solus/client-core/server-registry'
import { managedHostStateLabel } from '../../servers/lib/managed-host'

/**
 * Where automations live: on execution machines, never on the Solus API
 * (plans/004-shared-host-collaboration.md, C1 and item 2). The builder and the
 * page read `serversStore.executionServers` through these helpers.
 */
export interface AutomationMachine {
  id: string
  label: string
  status: string
  uplink?: SavedServerUplink
}

export interface AutomationMachineOption {
  value: string
  label: string
  /** A Solus-provisioned machine that is not ready is listed with its state but cannot take a new automation. */
  disabled: boolean
}

export const NO_MACHINE_LABEL = 'Choose a machine'

/**
 * The builder's machine menu: every connected execution machine that stores
 * automations, and each Solus-provisioned machine whose compute is not ready,
 * labelled with its state ("Starting", "Stopped") so the person sees why it
 * cannot be chosen.
 */
export function automationMachineOptions(
  machines: readonly AutomationMachine[],
  supportsAutomations: (serverId: string) => boolean,
): AutomationMachineOption[] {
  const options: AutomationMachineOption[] = []
  for (const machine of machines) {
    const state = managedHostStateLabel(machine.uplink)
    if (state) options.push({ value: machine.id, label: `${machine.label} · ${state}`, disabled: true })
    else if (machine.status === 'online' && supportsAutomations(machine.id)) {
      options.push({ value: machine.id, label: machine.label, disabled: false })
    }
  }
  return options
}

/** A new automation saves only to a machine the menu offers as ready. */
export function canSaveAutomationTo(options: readonly AutomationMachineOption[], serverId: string | null | undefined): boolean {
  return !!serverId && options.some((option) => option.value === serverId && !option.disabled)
}

/** The machine to keep selected: the current one while it can take the automation, else the first that can, else none. */
export function selectableAutomationMachine(options: readonly AutomationMachineOption[], serverId: string | null | undefined): string {
  if (serverId && canSaveAutomationTo(options, serverId)) return serverId
  return options.find((option) => !option.disabled)?.value ?? ''
}

/** The machines the automations page lists from: every connected execution machine. The store skips one without the automations capability. */
export function automationListMachineIds(machines: readonly AutomationMachine[]): string[] {
  return machines.filter((machine) => machine.status === 'online').map((machine) => machine.id)
}
