// ─── Policy API (plans/030 §5.2) ───
//
// The account plane's routes for an organization's policy and its host policies,
// read and written by owners from Settings → Policy on every client. Documents
// arrive unvalidated as `document` and are checked with `validatePolicyDocument`
// on both ends, so a newer schema reads as a refusal, not a crash.

import { z } from 'zod'

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
