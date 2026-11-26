// ─── Policy API (plans/030 §5.2) ───
//
// The account plane's routes for an organization's policy and its host policies,
// read and written by owners from Settings → Policy on every client. Documents
// arrive unvalidated as `document` and are checked with `validatePolicyDocument`
// on both ends, so a newer schema reads as a refusal, not a crash.

import { z } from 'zod'
import { directoryMemberSchema, organizationRoleSchema } from './uplink'

const documentEnvelope = {
  revision: z.number().int().nonnegative(),
  /** A `policy.json` document; decode with `validatePolicyDocument`. */
  document: z.unknown(),
  updatedAt: z.number(),
}

/** `GET /v1/orgs/:organizationId/policy`. */
export const organizationPolicyResponseSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string(),
  /** Computed by the control plane from current membership. Owners only. */
  canManage: z.boolean(),
  ...documentEnvelope,
})
export type OrganizationPolicyResponse = z.infer<typeof organizationPolicyResponseSchema>

export const hostPolicySummarySchema = z.object({
  policyId: z.string().min(1),
  name: z.string(),
  ...documentEnvelope,
  /** The hosts this organization assigned the policy to. */
  hostIds: z.array(z.string().min(1)),
})
export type HostPolicySummary = z.infer<typeof hostPolicySummarySchema>

/** One host shared with or managed by the organization, as the assignment list shows it. */
export const policyHostSchema = z.object({
  hostId: z.string().min(1),
  label: z.string(),
  /** This organization's host policy on the host, or null. */
  policyId: z.string().min(1).nullable(),
  /** The organization whose host policy holds `host` on this host; null when none. */
  hostOwner: z.object({ organizationId: z.string().min(1), name: z.string() }).nullable(),
})
export type PolicyHost = z.infer<typeof policyHostSchema>

/** `GET /v1/orgs/:organizationId/host-policies`. */
export const hostPoliciesResponseSchema = z.object({
  organizationId: z.string().min(1),
  canManage: z.boolean(),
  policies: z.array(hostPolicySummarySchema),
  hosts: z.array(policyHostSchema),
})
export type HostPoliciesResponse = z.infer<typeof hostPoliciesResponseSchema>

/** `PUT /v1/orgs/:organizationId/policy` and `PUT …/host-policies/:policyId`. */
export const policyWriteRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  document: z.unknown(),
}).strict()
export type PolicyWriteRequest = z.infer<typeof policyWriteRequestSchema>

/** `POST /v1/orgs/:organizationId/host-policies`. */
export const hostPolicyCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  document: z.unknown(),
}).strict()
export type HostPolicyCreateRequest = z.infer<typeof hostPolicyCreateRequestSchema>

/** `PUT /v1/orgs/:organizationId/hosts/:hostId/policy`. */
export const hostPolicyAssignRequestSchema = z.object({ policyId: z.string().min(1) }).strict()
export type HostPolicyAssignRequest = z.infer<typeof hostPolicyAssignRequestSchema>

/** 409 on a document write: someone saved first. */
export const policyConflictBodySchema = z.object({
  error: z.literal('policy_conflict'),
  revision: z.number().int().nonnegative(),
  document: z.unknown(),
})

/** 422: the validator refused the document, or an assignment brings `host` to a host another organization owns. */
export const policyRejectedBodySchema = z.object({
  error: z.enum(['policy_invalid', 'host_owned_by_other_organization']),
  issues: z.array(z.string()),
})

export const organizationPolicyPath = (organizationId: string): string => `/v1/orgs/${encodeURIComponent(organizationId)}/policy`
export const hostPoliciesPath = (organizationId: string): string => `/v1/orgs/${encodeURIComponent(organizationId)}/host-policies`
export const hostPolicyPath = (organizationId: string, policyId: string): string => `${hostPoliciesPath(organizationId)}/${encodeURIComponent(policyId)}`
export const hostPolicyAssignmentPath = (organizationId: string, hostId: string): string => `/v1/orgs/${encodeURIComponent(organizationId)}/hosts/${encodeURIComponent(hostId)}/policy`

// ─── Organization settings ───
//
// What an organization is and where its members run work: its name, its people,
// and its host rules (organization-scope §3.1). Every member reads them in
// Settings → Organization; only an owner changes them. The people themselves —
// invitations, roles, removal — are changed on the Solus console.

/** The host rules of an organization, and what a new cloud host of it starts with. */
export const organizationHostRulesSchema = z.object({
  allowCloudHosts: z.boolean(),
  allowPersonalHosts: z.boolean(),
  defaultPackages: z.array(z.string().min(1)),
  defaultSetupScript: z.string().nullable(),
})
export type OrganizationHostRules = z.infer<typeof organizationHostRulesSchema>

/** `GET /v1/orgs/:organizationId/settings`: members only. */
export const organizationSettingsResponseSchema = z.object({
  organizationId: z.string().min(1),
  name: z.string(),
  /** Made from the name when the organization was founded; a rename keeps it. */
  slug: z.string(),
  /** The caller's own role: an owner changes these settings, a member reads them. */
  role: organizationRoleSchema,
  members: z.array(directoryMemberSchema),
  hostRules: organizationHostRulesSchema,
  /** A host rules write names it, so a save from another owner is never overwritten unseen. */
  hostRulesRevision: z.number().int().nonnegative(),
})
export type OrganizationSettingsResponse = z.infer<typeof organizationSettingsResponseSchema>

/** The longest organization name, as the console allows. */
export const MAX_ORGANIZATION_NAME_LENGTH = 80

/**
 * `PATCH /v1/orgs/:organizationId/settings`: owners only. A rename, new host rules
 * against the revision that was read, or both. The answer is the settings after the write;
 * a 409 carries the current settings as its `document`.
 */
export const organizationSettingsPatchRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_ORGANIZATION_NAME_LENGTH).optional(),
    hostRules: organizationHostRulesSchema.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((request) => request.name !== undefined || request.hostRules !== undefined, { message: 'nothing to change' })
  .refine((request) => request.hostRules === undefined || request.expectedRevision !== undefined, { message: 'host rules need the revision they were read at', path: ['expectedRevision'] })
export type OrganizationSettingsPatchRequest = z.infer<typeof organizationSettingsPatchRequestSchema>

export const organizationSettingsPath = (organizationId: string): string => `/v1/orgs/${encodeURIComponent(organizationId)}/settings`
