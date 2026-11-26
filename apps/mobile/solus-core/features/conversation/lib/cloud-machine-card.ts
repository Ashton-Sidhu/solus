import {
  cloudMachineAnswers,
  cloudMachinePackagesProblem,
  MAX_CLOUD_MACHINE_NAME_LENGTH,
  parseCloudMachinePackages,
  type CloudMachineAsk,
  type CloudMachineChoice,
} from '@solus/contracts/cloud-machine-card'
import { MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH, type ManagedHostLifecycle, type ManagedHostSize } from '@solus/contracts/uplink'

/**
 * The rules of the phone's machine card (plans/035-cloud-machine-tools.md §6). The
 * ask holds everything that the card shows. The card only collects the choices and
 * answers with `respondQuestion`; the host tool checks the answer and makes the change.
 */

/** The values that the sheet edits. Packages are the text that the person types. */
export interface CloudMachineFields {
  organizationId: string | null
  name: string
  size: string | null
  packagesText: string
  setupScript: string
}

/** One row of the card's facts. `missing` shows the value in the warning colour. */
export interface CloudMachineFact {
  label: string
  value: string
  missing?: true
  /** The row shows the machine state as a chip. */
  state?: ManagedHostLifecycle | null
}

/** The name that Solus Cloud gives a new machine without one. */
const DEFAULT_MACHINE_NAME = 'Cloud host'

export function cardTitle(ask: CloudMachineAsk): string {
  if (ask.mode === 'create') return 'Create a cloud machine'
  if (ask.mode === 'edit') return 'Change machine setup'
  return 'Join a machine'
}

/** The label of the button that opens the sheet. */
export function reviewLabel(ask: CloudMachineAsk): string {
  if (ask.mode === 'create') return 'Review machine…'
  if (ask.mode === 'edit') return 'Edit setup…'
  return 'Choose organization…'
}

export function sheetTitle(ask: CloudMachineAsk): string {
  return ask.mode === 'edit' ? ask.host.name : cardTitle(ask)
}

/** A save restarts a machine that runs, and its sessions stop. */
export function restartsOnSave(ask: CloudMachineAsk): boolean {
  return ask.mode === 'edit' && ask.host.state === 'ready'
}

export function submitLabel(ask: CloudMachineAsk): string {
  if (ask.mode === 'create') return 'Create machine'
  if (ask.mode === 'join') return 'Join machine'
  return restartsOnSave(ask) ? 'Save and restart' : 'Save'
}

/** CPU and memory of a size, else the catalog's own detail. */
export function sizeDetail(size: ManagedHostSize): string {
  const parts = [
    size.cpus !== undefined ? `${size.cpus} CPU` : null,
    size.memoryGb !== undefined ? `${size.memoryGb} GB` : null,
  ].filter((part): part is string => part !== null)
  return parts.length ? parts.join(' · ') : size.detail
}

export function stateLabel(state: ManagedHostLifecycle | null): string {
  if (state === null) return 'Unknown'
  return state.charAt(0).toUpperCase() + state.slice(1)
}

/** The number of lines of a script, as the card shows it. */
export function scriptLines(script: string): string {
  const count = script.trim() ? script.trimEnd().split('\n').length : 0
  if (count === 0) return 'None'
  return count === 1 ? '1 line' : `${count} lines`
}

const packagesFact = (packages: readonly string[]): string => (packages.length ? packages.join(', ') : 'None')

/** The organization that the card selects first: the one the agent chose, else the only one. */
function initialOrganization(ask: Extract<CloudMachineAsk, { mode: 'create' | 'join' }>): string | null {
  const chosen = ask.mode === 'create' ? ask.draft.organizationId : undefined
  if (chosen && ask.organizations.some((organization) => organization.id === chosen)) return chosen
  return ask.organizations.length === 1 ? ask.organizations[0]!.id : null
}

/** The size that the card selects first: the one the agent chose, else the catalog's default. */
function initialSize(ask: Extract<CloudMachineAsk, { mode: 'create' }>): string | null {
  const { sizes, defaultSize } = ask.catalog
  const known = (id: string | null | undefined) => (id && sizes.some((size) => size.id === id) ? id : null)
  return known(ask.draft.size) ?? known(defaultSize) ?? sizes[0]?.id ?? null
}

/** The sheet's values before the person changes them: the agent's draft, or the machine's current setup. */
export function initialFields(ask: CloudMachineAsk): CloudMachineFields {
  if (ask.mode === 'edit') {
    return {
      organizationId: null,
      name: '',
      size: null,
      packagesText: ask.current.packages.join(' '),
      setupScript: ask.current.setupScript,
    }
  }
  if (ask.mode === 'join') {
    return { organizationId: initialOrganization(ask), name: '', size: null, packagesText: '', setupScript: '' }
  }
  return {
    organizationId: initialOrganization(ask),
    name: ask.draft.name ?? '',
    size: initialSize(ask),
    packagesText: (ask.draft.packages ?? []).join(' '),
    setupScript: ask.draft.setupScript ?? '',
  }
}

/** The facts the card shows for the values in `fields`. */
export function cardFacts(ask: CloudMachineAsk, fields: CloudMachineFields): CloudMachineFact[] {
  if (ask.mode === 'edit') {
    return [
      { label: 'Machine', value: ask.host.name },
      { label: 'State', value: stateLabel(ask.host.state), state: ask.host.state },
      { label: 'Packages', value: packagesFact(parseCloudMachinePackages(fields.packagesText)) },
      { label: 'Setup script', value: scriptLines(fields.setupScript) },
    ]
  }
  const organization = ask.organizations.find((row) => row.id === fields.organizationId)
  const organizationFact: CloudMachineFact = organization
    ? { label: 'Organization', value: organization.name }
    : { label: 'Organization', value: 'Choose one', missing: true }
  if (ask.mode === 'join') return [{ label: 'Address', value: ask.address }, organizationFact]
  const facts: CloudMachineFact[] = [organizationFact, { label: 'Name', value: fields.name.trim() || DEFAULT_MACHINE_NAME }]
  const size = ask.catalog.sizes.find((row) => row.id === fields.size)
  if (size) facts.push({ label: 'Size', value: `${size.label} · ${sizeDetail(size)}` })
  if (ask.catalog.supportsPackages) {
    facts.push({ label: 'Packages', value: packagesFact(parseCloudMachinePackages(fields.packagesText)) })
  }
  if (ask.catalog.supportsSetupScript && fields.setupScript.trim()) {
    facts.push({ label: 'Setup script', value: scriptLines(fields.setupScript) })
  }
  return facts
}

/** The sheet shows the organization rows only when there is a choice to make. */
export function asksOrganization(ask: CloudMachineAsk): boolean {
  return ask.mode === 'join' || (ask.mode === 'create' && ask.organizations.length > 1)
}

const offersPackages = (ask: CloudMachineAsk) => ask.mode === 'edit' || (ask.mode === 'create' && ask.catalog.supportsPackages)
const offersSetupScript = (ask: CloudMachineAsk) => ask.mode === 'edit' || (ask.mode === 'create' && ask.catalog.supportsSetupScript)

export function sheetOffers(ask: CloudMachineAsk) {
  return {
    packages: offersPackages(ask),
    setupScript: offersSetupScript(ask),
    name: ask.mode === 'create',
    sizes: ask.mode === 'create' && ask.catalog.sizes.length > 1,
  }
}

/** The problem of the packages field, else null. */
export function packagesProblem(ask: CloudMachineAsk, fields: CloudMachineFields): string | null {
  return offersPackages(ask) ? cloudMachinePackagesProblem(parseCloudMachinePackages(fields.packagesText)) : null
}

/** Why the sheet cannot send its values; null when it can. */
export function fieldsProblem(ask: CloudMachineAsk, fields: CloudMachineFields): string | null {
  if (ask.mode !== 'edit' && !ask.organizations.some((organization) => organization.id === fields.organizationId)) {
    return 'Choose an organization.'
  }
  if (ask.mode === 'create') {
    if (fields.name.trim().length > MAX_CLOUD_MACHINE_NAME_LENGTH) return `A name has at most ${MAX_CLOUD_MACHINE_NAME_LENGTH} characters.`
    if (ask.catalog.sizes.length > 0 && !ask.catalog.sizes.some((size) => size.id === fields.size)) return 'Choose a size.'
  }
  const packages = packagesProblem(ask, fields)
  if (packages) return packages
  if (offersSetupScript(ask) && fields.setupScript.length > MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH) {
    return `A setup script has at most ${MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH} characters.`
  }
  return null
}

/** The `respondQuestion` answers for the sheet's values. Call it only when `fieldsProblem` is null. */
export function chosenAnswers(ask: CloudMachineAsk, fields: CloudMachineFields): Record<string, string> {
  const choice: CloudMachineChoice = {}
  if (ask.mode !== 'edit' && fields.organizationId) choice.organizationId = fields.organizationId
  if (ask.mode === 'create') {
    const name = fields.name.trim()
    if (name) choice.name = name
    if (fields.size) choice.size = fields.size
  }
  if (offersPackages(ask)) choice.packages = parseCloudMachinePackages(fields.packagesText)
  if (offersSetupScript(ask)) choice.setupScript = fields.setupScript
  return cloudMachineAnswers({ status: 'chosen', choice })
}

export const declinedAnswers = (): Record<string, string> => cloudMachineAnswers({ status: 'declined' })
