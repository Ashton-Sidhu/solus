import { z } from 'zod'
import { hostCategorySchema, hostOrganizationSchema, hostOwnerIdentitySchema } from './uplink'

/**
 * Organization scope on a host (docs/plans/organization-scope.md §3, §6.1, §7):
 * what a client reads about the machine's standing, how it opts a machine's
 * work into an organization's Insights when that organization's policy is off,
 * and the recoverable publication that moves a Local resource into one
 * organization on Share or Move.
 */

/**
 * Why a host refused to start a turn under the organization model (organization-scope
 * §3.1; organization-vms §4). The client keeps the draft for every one of them: the
 * person fixes the cause (chooses an organization, reconnects, waits for the API)
 * and sends the same text again.
 */
export const turnRefusalSchema = z.enum([
  'PERSONAL_HOSTS_NOT_ALLOWED',
  'ORGANIZATION_NOT_ALLOWED',
  'ORGANIZATION_REQUIRED',
  'ORGANIZATION_ACCESS_REFUSED',
  'ORGANIZATION_API_UNAVAILABLE',
  'ORGANIZATION_AUTHORITY_MISSING',
])
export type TurnRefusal = z.infer<typeof turnRefusalSchema>

/** `hostOrganizations`: this machine's standing, as the control plane last answered and the host's own choices. */
export const hostOrganizationsStatusSchema = z.object({
  /** The host holds a cloud link; without one it stands in no organization. */
  linked: z.boolean(),
  hostId: z.string().nullable(),
  category: hostCategorySchema,
  /** The account that linked this host; null on a managed host or before the control plane answered. */
  owner: hostOwnerIdentitySchema.nullable(),
  /** The organizations this host may deliver records to, each with its policy. */
  organizations: z.array(hostOrganizationSchema),
  /** Organizations the person at this host opted its work into while their **Sync all Insights** is off (§6.1). */
  insightsOptIn: z.array(z.string()),
  /**
   * When this host was attached for organization work (organization-vms §4): new
   * root sessions, tasks, and works then start in a client's organization on the
   * Solus API, and new personal ones are refused. Null on a personal host; an
   * unlink resets it.
   */
  attachedAt: z.number().nullable(),
  /** The Solus API the link names for organization records; null while unlinked. */
  apiUrl: z.string().nullable(),
  /** What waits to reach each organization's Solus API: queued items, and outbox operations the service refused for good. */
  delivery: z.array(z.object({ organizationId: z.string(), pending: z.number().int().nonnegative(), failed: z.number().int().nonnegative() })),
  /** The last delivery error, until a delivery succeeds; never a credential. */
  deliveryError: z.string().nullable(),
})
export type HostOrganizationsStatus = z.infer<typeof hostOrganizationsStatusSchema>

