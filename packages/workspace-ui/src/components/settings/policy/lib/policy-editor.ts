import {
  organizationPolicyTemplate,
  policySourceLabel,
  type PolicySet,
  validatePolicyDocument,
  type PolicyDocument,
  type PolicyKind,
} from '@solus/contracts/policy'
import type { HostPolicySummary, PolicyHost } from '@solus/contracts/policy-api'
import type { PolicyApiResult } from '@solus/contracts/host-api'

/**
 * Settings → Policy (plans/030 §7), without the UI: the text of a document, its
 * check, what an import or an edit changes, and which host policies a host can
 * take. Every check is the contract's validator, so the editor refuses exactly
 * what the cloud and the host refuse.
 */

export type PolicyTextCheck = { ok: true; document: PolicyDocument } | { ok: false; issues: string[] }

/** The editor's text as a document of `kind`. */
export function checkPolicyText(text: string, kind: PolicyKind): PolicyTextCheck {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch (error) {
    return { ok: false, issues: [`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  return validatePolicyDocument(input, kind)
}

export function policyText(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

/** A first document for each kind. An organization policy starts from today's defaults (§4.5). */
export function newPolicyDocument(kind: PolicyKind, organizationName: string, name?: string): PolicyDocument {
  const organization = { name: organizationName.trim() || 'My organization' }
  if (kind === 'organization') return organizationPolicyTemplate(organization.name)
  return name ? { schemaVersion: 1, organization, name } : { schemaVersion: 1, organization }
}

/** "Copy as new" from a policy that is read-only here: the revision belongs to the original. */
export function copyAsNew(document: PolicyDocument): PolicyDocument {
  const { revision: _revision, ...copy } = document
  return copy
}

export interface PolicyDifference {
  /** `sessions.limits.maxPermissionMode` */
  path: string
  change: 'added' | 'removed' | 'changed'
  /** JSON of the value before and after; absent where there is none. */
  before?: string
  after?: string
}

/** What `after` changes in `before`, one line for each leaf. An array is one value. */
export function policyDifferences(before: unknown, after: unknown): PolicyDifference[] {
  const left = leaves(before)
  const right = leaves(after)
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort()
  const out: PolicyDifference[] = []
  for (const path of paths) {
    const was = left.get(path)
    const is = right.get(path)
    if (was === is) continue
    if (was === undefined) out.push({ path, change: 'added', after: is })
    else if (is === undefined) out.push({ path, change: 'removed', before: was })
    else out.push({ path, change: 'changed', before: was, after: is })
  }
  return out
}

function leaves(value: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value).filter(([, child]) => child !== undefined)
    if (entries.length === 0 && prefix) out.set(prefix, '{}')
    for (const [key, child] of entries) leaves(child, prefix ? `${prefix}.${key}` : key, out)
    return out
  }
  if (value !== undefined && prefix) out.set(prefix, JSON.stringify(value))
  return out
}

/** One sentence for a difference, as the import confirmation lists it. */
export function differenceLine(difference: PolicyDifference): string {
  switch (difference.change) {
    case 'added': return `${difference.path}: set to ${difference.after}`
    case 'removed': return `${difference.path}: removed (was ${difference.before})`
    case 'changed': return `${difference.path}: ${difference.before} → ${difference.after}`
  }
}

export interface AssignableHostPolicy {
  policyId: string
  name: string
  /** Null when the policy can be assigned to the host. */
  blockedReason: string | null
}

/**
 * The host policies an organization can assign to one host. Another
 * organization holds the host's `host` section, so only a policy without one
 * can go there (§3); the cloud refuses the rest anyway.
 */
export function assignableHostPolicies(host: PolicyHost, organizationId: string, policies: readonly HostPolicySummary[]): AssignableHostPolicy[] {
  const owner = host.hostOwner && host.hostOwner.organizationId !== organizationId ? host.hostOwner : null
  return policies.map((policy) => ({
    policyId: policy.policyId,
    name: policy.name,
    blockedReason: owner && holdsHostSection(policy.document)
      ? `${owner.name} manages this host's settings. Only a host policy without host settings can be assigned.`
      : null,
  }))
}

/** The line under a host in the assignment list. */
export function policyHostDetail(host: PolicyHost, organizationId: string, policies: readonly HostPolicySummary[]): string {
  const assigned = host.policyId ? policies.find((policy) => policy.policyId === host.policyId)?.name ?? 'A removed policy' : 'No host policy'
  if (!host.hostOwner) return assigned
  return host.hostOwner.organizationId === organizationId
    ? `${assigned} · this organization manages the host's settings`
    : `${assigned} · host settings managed by ${host.hostOwner.name}`
}

function holdsHostSection(document: unknown): boolean {
  return document !== null && typeof document === 'object' && 'host' in document && (document as { host?: unknown }).host !== undefined
}

/** A policy API refusal in words; null for `ok`. */
export function policyResultMessage(result: PolicyApiResult<unknown>): string | null {
  switch (result.kind) {
    case 'ok': return null
    case 'conflict': return 'Another owner saved this policy while you edited it. Nothing of yours was saved.'
    case 'rejected':
      return result.reason === 'host_owned_by_other_organization'
        ? `Another organization manages this host's settings. ${result.issues.join(' ')}`.trim()
        : `Solus Cloud refused this policy: ${result.issues.join('; ')}`
    case 'forbidden': return 'Only owners of this organization can change its policies.'
    case 'signed-out': return 'Sign in to Solus again to change policies.'
    case 'offline': return 'Solus could not reach your account. Nothing was saved. Try again when you are online.'
    case 'error': return result.message ?? `Solus Cloud did not accept the change (${result.code}).`
  }
}

/** The "This host" section's sentence: what the MDM policy is, or that there is none. */
export function mdmDescription(set: PolicySet | undefined): string {
  if (!set?.mdm) return 'This host has no MDM policy. Cloud policies apply to the work of their own organization.'
  const label = policySourceLabel(set.mdm)
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} applies to all work on this host and comes before every cloud policy. Change it with your MDM tool.`
}

/** The organization that manages this host's settings, by name; null when none does. */
export function hostOwnerName(set: PolicySet | undefined, organizations: readonly { organizationId: string; name: string }[]): string | null {
  const ownerId = set?.hostOwnerOrganizationId
  if (!ownerId || set.mdm) return null
  const entry = set.organizations[ownerId]
  if (entry?.state === 'ready') return entry.policy.document.organization.name
  return organizations.find((organization) => organization.organizationId === ownerId)?.name ?? ownerId
}
