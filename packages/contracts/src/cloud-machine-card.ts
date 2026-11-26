import { MANAGED_HOST_PACKAGE_PATTERN, MAX_MANAGED_HOST_PACKAGES, MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH, type ManagedHostCatalog, type ManagedHostLifecycle } from './uplink'

/**
 * The machine card (plans/035-cloud-machine-tools.md §6). A cloud machine tool shows
 * it when the person did not give a choice that the tool needs: the organization of a
 * new machine, or what to change on one. The card only collects the choices; the tool
 * then makes the change on the host. Question kind `cloud-machine`, answered with
 * `respondQuestion` and `cloudMachineAnswers`. The ask carries everything the card
 * shows, so a client makes no account call for it.
 */

/** The longest name of a new machine, as `createManagedHostRequestSchema` allows. */
export const MAX_CLOUD_MACHINE_NAME_LENGTH = 120

/** One organization the person may choose. */
export interface CloudMachineOrganization {
  id: string
  name: string
}

/** What the agent chose for a new machine; the card fills in the rest. */
export interface CloudMachineDraft {
  organizationId?: string
  name?: string
  size?: string
  packages?: string[]
  setupScript?: string
}

/** The machine an edit card changes. */
export interface CloudMachineTarget {
  hostId: string
  name: string
  state: ManagedHostLifecycle | null
  /** The label of its size, when the catalog names it. */
  size: string | null
}

export type CloudMachineAsk =
  | { mode: 'create'; reason: string; organizations: CloudMachineOrganization[]; catalog: ManagedHostCatalog; draft: CloudMachineDraft }
  | { mode: 'edit'; reason: string; host: CloudMachineTarget; current: { packages: string[]; setupScript: string } }
  | { mode: 'join'; reason: string; organizations: CloudMachineOrganization[]; address: string }

/** What the card chose. `create` gives each field; `edit` gives packages and the script; `join` gives the organization. */
export interface CloudMachineChoice {
  organizationId?: string
  name?: string
  size?: string
  packages?: string[]
  setupScript?: string
}

export type CloudMachineAnswer = { status: 'chosen'; choice: CloudMachineChoice } | { status: 'declined' }

/** The `respondQuestion` answers of a card. Packages are one string, separated by spaces. */
export function cloudMachineAnswers(answer: CloudMachineAnswer): Record<string, string> {
  if (answer.status === 'declined') return { status: 'declined' }
  const answers: Record<string, string> = { status: 'chosen' }
  const { organizationId, name, size, packages, setupScript } = answer.choice
  if (organizationId !== undefined) answers.organizationId = organizationId
  if (name !== undefined) answers.name = name
  if (size !== undefined) answers.size = size
  if (packages !== undefined) answers.packages = packages.join(' ')
  if (setupScript !== undefined) answers.setupScript = setupScript
  return answers
}

/** Packages as a person types them: separated by spaces, commas, or new lines. */
export function parseCloudMachinePackages(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean)
}

/** Why a list of packages cannot go to Solus Cloud; null when it can. */
export function cloudMachinePackagesProblem(packages: readonly string[]): string | null {
  if (packages.length > MAX_MANAGED_HOST_PACKAGES) return `A machine takes at most ${MAX_MANAGED_HOST_PACKAGES} packages.`
  const bad = packages.find((name) => !MANAGED_HOST_PACKAGE_PATTERN.test(name))
  return bad ? `"${bad}" is not a package name.` : null
}

/**
 * The choice in a card's answers, checked against the ask that the tool sent: the
 * answer comes from a client, so an organization outside the list, a size outside the
 * catalog, or a package or script that Solus Cloud refuses is not a choice. Null for
 * an answer that is not one.
 */
export function readCloudMachineAnswer(ask: CloudMachineAsk, answers: Record<string, string>): CloudMachineAnswer | null {
  if (answers.status === 'declined') return { status: 'declined' }
  if (answers.status !== 'chosen') return null
  const choice: CloudMachineChoice = {}
  if (ask.mode !== 'edit') {
    const organizationId = answers.organizationId
    if (!organizationId || !ask.organizations.some((organization) => organization.id === organizationId)) return null
    choice.organizationId = organizationId
  }
  if (ask.mode === 'create') {
    const name = answers.name?.trim()
    if (name) {
      if (name.length > MAX_CLOUD_MACHINE_NAME_LENGTH) return null
      choice.name = name
    }
    if (answers.size !== undefined) {
      if (!ask.catalog.sizes.some((size) => size.id === answers.size)) return null
      choice.size = answers.size
    }
  }
  if (ask.mode !== 'join') {
    if (answers.packages !== undefined) {
      const packages = parseCloudMachinePackages(answers.packages)
      if (cloudMachinePackagesProblem(packages)) return null
      choice.packages = packages
    }
    if (answers.setupScript !== undefined) {
      if (answers.setupScript.length > MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH) return null
      choice.setupScript = answers.setupScript
    }
  }
  return { status: 'chosen', choice }
}
