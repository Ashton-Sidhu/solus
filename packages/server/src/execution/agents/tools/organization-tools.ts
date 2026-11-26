import { z } from 'zod'
import { MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH, organizationDirectorySchema } from '@solus/contracts/uplink'
import {
  MAX_ORGANIZATION_NAME_LENGTH,
  organizationSettingsPath,
  organizationSettingsResponseSchema,
  type OrganizationHostRules,
  type OrganizationSettingsPatchRequest,
  type OrganizationSettingsResponse,
} from '@solus/contracts/policy-api'
import { cloudMachinePackagesProblem, type CloudMachineOrganization } from '@solus/contracts/cloud-machine-card'
import type { AgentTool, AgentToolContext, AgentToolResult } from './agent-tool'
import {
  SIGN_IN,
  answered,
  chosenOrganization,
  cloudPerson,
  cloudRequest,
  failed,
  isCloudPersonOffered,
  organizationNames,
  organizationsOf,
  readDirectory,
  type CloudPerson,
} from './cloud-machine-tools'

/**
 * The organization tools (plans/035-cloud-machine-tools.md §10): the people and teams of
 * an organization, and its name and host rules. Each request goes to Solus Cloud as the
 * person of the turn, as the cloud machine tools do; the same people get them.
 */

const organizationField = z.string().max(200).optional().describe('An organization id or name; the session\'s organization, or your only one, when absent.')

/** The person and the organization a call is for, or the sentence that says why not. */
async function personAndOrganization(context: AgentToolContext, named: string | undefined): Promise<{ person: CloudPerson; organization: CloudMachineOrganization } | AgentToolResult> {
  const person = await cloudPerson(context)
  if (!person) return failed(SIGN_IN)
  const directory = await readDirectory(person)
  if (!directory.ok) return failed(directory.text)
  const organizations = organizationsOf(directory.value)
  const chosen = chosenOrganization(person, organizations, named)
  if ('problem' in chosen) return failed(chosen.problem)
  if (!chosen.organization) return failed(`Name the organization. Your organizations: ${organizationNames(organizations)}.`)
  return { person, organization: chosen.organization }
}

const policyFacts = (settings: OrganizationSettingsResponse) => ({
  organizationId: settings.organizationId,
  name: settings.name,
  yourRole: settings.role,
  hostRules: settings.hostRules,
  revision: settings.hostRulesRevision,
})

export const listOrganizationMembersAgentTool: AgentTool<{ organization: typeof organizationField }> = {
  name: 'list_organization_members',
  description: 'List the people and teams of an organization, with their ids and roles. Use it to find a person or a team by name.',
  inputFields: { organization: organizationField },
  requiresApproval: false,
  isOffered: isCloudPersonOffered,
  async execute(input, context) {
    const found = await personAndOrganization(context, input.organization)
    if ('ok' in found) return found
    const directory = await cloudRequest(found.person, `/v1/orgs/${encodeURIComponent(found.organization.id)}/directory`, organizationDirectorySchema)
    if (!directory.ok) return failed(directory.text)
    const { organizationId, name, members, teams } = directory.value
    return answered({
      organizationId,
      name,
      members: members.map(({ userId, name: memberName, email, role }) => ({ userId, name: memberName, email, role })),
      teams,
    })
  },
}

export const readOrganizationPolicyAgentTool: AgentTool<{ organization: typeof organizationField }> = {
  name: 'read_organization_policy',
  description: 'Read an organization\'s name, your role in it, and its host rules: whether cloud machines and personal hosts are allowed, and the default packages and setup script of a new cloud machine. Use it when a create or join is refused.',
  inputFields: { organization: organizationField },
  requiresApproval: false,
  isOffered: isCloudPersonOffered,
  async execute(input, context) {
    const found = await personAndOrganization(context, input.organization)
    if ('ok' in found) return found
    const settings = await cloudRequest(found.person, organizationSettingsPath(found.organization.id), organizationSettingsResponseSchema)
    return settings.ok ? answered(policyFacts(settings.value)) : failed(settings.text)
  },
}

const updatePolicyFields = {
  organization: organizationField,
  name: z.string().trim().min(1).max(MAX_ORGANIZATION_NAME_LENGTH).optional().describe('A new name for the organization.'),
  allow_cloud_hosts: z.boolean().optional(),
  allow_personal_hosts: z.boolean().optional(),
  default_packages: z.array(z.string().max(128)).max(64).optional().describe('The full list of apt packages a new cloud machine starts with; [] clears it.'),
  default_setup_script: z.string().max(MAX_MANAGED_HOST_SETUP_SCRIPT_LENGTH).nullable().optional().describe('The setup script a new cloud machine starts with; null clears it.'),
}

/** The rules the person asked for, on the rules that were read: a field not given keeps its value. */
function mergedRules(rules: OrganizationHostRules, input: z.output<z.ZodObject<typeof updatePolicyFields>>): OrganizationHostRules {
  return {
    allowCloudHosts: input.allow_cloud_hosts ?? rules.allowCloudHosts,
    allowPersonalHosts: input.allow_personal_hosts ?? rules.allowPersonalHosts,
    defaultPackages: input.default_packages ?? rules.defaultPackages,
    defaultSetupScript: input.default_setup_script === undefined ? rules.defaultSetupScript : input.default_setup_script,
  }
}

/** A 409 of a settings write carries the current settings. */
const conflictSchema = z.object({ document: organizationSettingsResponseSchema })

export const updateOrganizationPolicyAgentTool: AgentTool<typeof updatePolicyFields> = {
  name: 'update_organization_policy',
  description: 'Rename an organization or change its host rules. Give only what the person asked to change; the other rules stay. It applies to every member and host of the organization at once. Organization owners only.',
  inputFields: updatePolicyFields,
  // A change applies to every member and every host of the organization at once (§10).
  requiresApproval: true,
  isOffered: isCloudPersonOffered,
  async execute(input, context) {
    const found = await personAndOrganization(context, input.organization)
    if ('ok' in found) return found
    const { person, organization } = found
    if (input.default_packages) {
      const problem = cloudMachinePackagesProblem(input.default_packages)
      if (problem) return failed(problem)
    }
    const changesRules = input.allow_cloud_hosts !== undefined || input.allow_personal_hosts !== undefined
      || input.default_packages !== undefined || input.default_setup_script !== undefined
    if (!changesRules && input.name === undefined) return failed('Give a name or a host rule to change.')
    const path = organizationSettingsPath(organization.id)
    // The rules are read first, and the write names their revision: it never writes over another owner's newer save.
    const current = await cloudRequest(person, path, organizationSettingsResponseSchema)
    if (!current.ok) return failed(current.text)
    if (current.value.role !== 'owner') return failed('Only an organization owner can change its settings.')
    const patch: OrganizationSettingsPatchRequest = {}
    if (input.name !== undefined) patch.name = input.name
    if (changesRules) {
      patch.hostRules = mergedRules(current.value.hostRules, input)
      patch.expectedRevision = current.value.hostRulesRevision
    }
    const written = await cloudRequest(person, path, organizationSettingsResponseSchema, { method: 'PATCH', body: patch })
    if (written.ok) return answered({ changed: true, ...policyFacts(written.value) })
    if (written.status === 409) {
      const newer = conflictSchema.safeParse(written.body)
      return failed(`Another owner changed these settings since they were read. Nothing was written. The current settings: ${JSON.stringify(newer.success ? policyFacts(newer.data.document) : null)}. Ask the person again with these.`)
    }
    return failed(written.text)
  },
}
