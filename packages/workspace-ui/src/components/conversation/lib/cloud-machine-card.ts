import {
  cloudMachineAnswers,
  cloudMachinePackagesProblem,
  MAX_CLOUD_MACHINE_NAME_LENGTH,
  parseCloudMachinePackages,
  type CloudMachineAsk,
  type CloudMachineChoice,
  type CloudMachineOrganization,
} from '@solus/contracts/cloud-machine-card'
import { MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH, type ManagedHostCatalog } from '@solus/contracts/uplink'
import { defaultSize, newCloudHostLabel, sizeSummary } from '../../onboarding/lib/cloud-compute'
import { managedHostLifecycleLabel } from '../../servers/lib/managed-host'

/**
 * The machine card of a cloud machine tool (plans/035-cloud-machine-tools.md §6).
 * The card shows the facts of the ask, the person opens the fields, and the card
 * answers with the choice. These functions hold its rules; the card holds only
 * markup and handlers.
 */

/** What the person types on the card. Packages are the text of the field. */
export interface CloudMachineForm {
  /** Empty when the person did not choose one yet. */
  organizationId: string
  name: string
  sizeId: string | null
  packages: string
  setupScript: string
}

/** One line of the fact list. `isMissing` shows the value in the warning colour. */
export interface CloudMachineFact {
  label: string
  value: string
  isMissing?: boolean
}

export type CloudMachineField = 'organization' | 'name' | 'packages' | 'setupScript'

export type CloudMachineSubmit =
  | { ok: true; answers: Record<string, string> }
  | { ok: false; field: CloudMachineField; problem: string }

export function cloudMachineCardTitle(ask: CloudMachineAsk): string {
  if (ask.mode === 'create') return 'Create a cloud machine'
  if (ask.mode === 'edit') return 'Change machine setup'
  return 'Join a machine'
}

/** The control that opens the fields. Join has no facts, so its fields show at once. */
export function cloudMachineReviewLabel(ask: CloudMachineAsk): string | null {
  if (ask.mode === 'create') return 'Review machine…'
  if (ask.mode === 'edit') return 'Edit setup…'
  return null
}

export function cloudMachineSubmitLabel(ask: CloudMachineAsk): string {
  if (ask.mode === 'create') return 'Create machine'
  if (ask.mode === 'edit') return restartsMachine(ask) ? 'Save and restart' : 'Save'
  return 'Join machine'
}

/** A change to a running machine restarts it, and its sessions stop. */
export function restartsMachine(ask: CloudMachineAsk): boolean {
  return ask.mode === 'edit' && ask.host.state === 'ready'
}

/** The size that the card selects at first: the draft's when the catalog has it, else the catalog's default. */
export function initialSizeId(catalog: ManagedHostCatalog, draftSize: string | undefined): string | null {
  if (draftSize && catalog.sizes.some((size) => size.id === draftSize)) return draftSize
  return defaultSize(catalog)?.id ?? null
}

/** The organization that the card selects at first: the draft's when it is in the list, else the only one. */
function initialOrganizationId(organizations: readonly CloudMachineOrganization[], draftId: string | undefined): string {
  if (draftId && organizations.some((organization) => organization.id === draftId)) return draftId
  return organizations.length === 1 ? organizations[0].id : ''
}

/** The fields, filled from the agent's draft (create) or the machine's setup now (edit). */
export function initialCloudMachineForm(ask: CloudMachineAsk): CloudMachineForm {
  if (ask.mode === 'create') {
    return {
      organizationId: initialOrganizationId(ask.organizations, ask.draft.organizationId),
      name: ask.draft.name ?? '',
      sizeId: initialSizeId(ask.catalog, ask.draft.size),
      packages: (ask.draft.packages ?? []).join(' '),
      setupScript: ask.draft.setupScript ?? '',
    }
  }
  if (ask.mode === 'edit') {
    return { organizationId: '', name: '', sizeId: null, packages: ask.current.packages.join(' '), setupScript: ask.current.setupScript }
  }
  return { organizationId: initialOrganizationId(ask.organizations, undefined), name: '', sizeId: null, packages: '', setupScript: '' }
}

/** "None", "1 line", or "12 lines". */
export function setupScriptSummary(script: string): string {
  const text = script.trim()
  if (!text) return 'None'
  const lines = text.split('\n').length
  return lines === 1 ? '1 line' : `${lines} lines`
}

function packagesSummary(packages: readonly string[]): string {
  return packages.length > 0 ? packages.join(', ') : 'None'
}

/** The fact list of a card. A join card shows its address, and its organization when there is no choice to make. */
export function cloudMachineFacts(ask: CloudMachineAsk): CloudMachineFact[] {
  if (ask.mode === 'create') {
    const organization = ask.organizations.find((entry) => entry.id === initialOrganizationId(ask.organizations, ask.draft.organizationId)) ?? null
    const size = ask.catalog.sizes.find((entry) => entry.id === initialSizeId(ask.catalog, ask.draft.size)) ?? null
    const facts: CloudMachineFact[] = [
      organization ? { label: 'Organization', value: organization.name } : { label: 'Organization', value: 'Choose one', isMissing: true },
      { label: 'Name', value: ask.draft.name?.trim() || newCloudHostLabel(organization) },
      { label: 'Size', value: size ? `${size.label} · ${sizeSummary(size)}` : 'Default' },
    ]
    if (ask.catalog.supportsPackages) facts.push({ label: 'Packages', value: packagesSummary(ask.draft.packages ?? []) })
    return facts
  }
  if (ask.mode === 'edit') {
    return [
      { label: 'Machine', value: ask.host.name },
      { label: 'State', value: ask.host.state ? managedHostLifecycleLabel(ask.host.state) : 'Unknown' },
      { label: 'Packages', value: packagesSummary(ask.current.packages) },
      { label: 'Setup script', value: setupScriptSummary(ask.current.setupScript) },
    ]
  }
  const facts: CloudMachineFact[] = [{ label: 'Address', value: ask.address }]
  if (ask.organizations.length === 1) facts.push({ label: 'Organization', value: ask.organizations[0].name })
  return facts
}

/**
 * The answers that the card sends for the form, or the first field that stops
 * it. The tool checks the answer again against the ask (`readCloudMachineAnswer`);
 * these checks only let the card show the problem before it sends.
 */
export function cloudMachineSubmit(ask: CloudMachineAsk, form: CloudMachineForm): CloudMachineSubmit {
  const choice: CloudMachineChoice = {}
  if (ask.mode !== 'edit') {
    if (!ask.organizations.some((organization) => organization.id === form.organizationId)) {
      return { ok: false, field: 'organization', problem: 'Choose an organization.' }
    }
    choice.organizationId = form.organizationId
  }
  if (ask.mode === 'create') {
    const name = form.name.trim()
    if (name.length > MAX_CLOUD_MACHINE_NAME_LENGTH) {
      return { ok: false, field: 'name', problem: `The name is too long. Keep it under ${MAX_CLOUD_MACHINE_NAME_LENGTH} characters.` }
    }
    if (name) choice.name = name
    if (form.sizeId && ask.catalog.sizes.some((size) => size.id === form.sizeId)) choice.size = form.sizeId
  }
  if (ask.mode !== 'join') {
    const takesPackages = ask.mode === 'edit' || ask.catalog.supportsPackages
    const takesSetupScript = ask.mode === 'edit' || ask.catalog.supportsSetupScript
    if (takesPackages) {
      const packages = parseCloudMachinePackages(form.packages)
      const problem = cloudMachinePackagesProblem(packages)
      if (problem) return { ok: false, field: 'packages', problem }
      choice.packages = packages
    }
    if (takesSetupScript) {
      const setupScript = form.setupScript.trim()
      if (setupScript.length > MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH) {
        return { ok: false, field: 'setupScript', problem: `The setup script is too long. Keep it under ${MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH / 1024} KB.` }
      }
      choice.setupScript = setupScript
    }
  }
  return { ok: true, answers: cloudMachineAnswers({ status: 'chosen', choice }) }
}
