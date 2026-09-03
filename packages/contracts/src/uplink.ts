/**
 * Personal Uplink — the public contract between a Solus host, its clients, and the
 * Solus control plane (docs/plans/personal-uplink.md). The schemas are the contract:
 * every side decodes with them and derives its types from them, so the wire cannot
 * drift from the code. The control plane keeps a verbatim copy of this file
 * (`bun run contracts:sync` there); this file must therefore import nothing but zod.
 * Nothing here is a secret and nothing is a constant of one deployment: issuer, JWKS,
 * and directory URLs reach the host in `UplinkLinkConfig` when it links.
 */

import { z } from 'zod'

/** A grant lives at most ten minutes; revocation is expiry. */
export const HOST_GRANT_TTL_SECONDS = 600

/** JWT claims of a host grant. ES256; `kid` in the header. */
export interface HostGrantClaims {
  iss: string
  /** The host id. A host refuses a grant minted for another host. */
  aud: string
  /** The owner's user id. */
  sub: string
  /** The account session that asked for the grant; revoking it stops new grants. */
  deviceId: string
  jti: string
  iat: number
  /** ≤ iat + HOST_GRANT_TTL_SECONDS */
  exp: number
}

const hostOperatingSystemSchema = z.enum(['macos', 'windows', 'linux'])

/** Non-secret link record kept on the host. Never constants. */
export const uplinkLinkConfigSchema = z.object({
  hostId: z.string().min(1),
  issuer: z.string().min(1),
  jwksUrl: z.string().min(1),
  /** Origin of the `/v1` API the host calls for its own link record. */
  directoryUrl: z.string().min(1),
  /** `h-<hostId>.<tunnelDomain>`; the tunnel route is `https://` + this. */
  hostname: z.string().min(1),
  /** Loopback port the connector forwards to; never a trusted requester. */
  proxiedPort: z.number().int().positive(),
  /** Advances on every enroll and delete. A host with an older value is superseded. */
  connectionGeneration: z.number().int().nonnegative(),
})
export type UplinkLinkConfig = z.infer<typeof uplinkLinkConfigSchema>

export const uplinkDesiredStateSchema = z.enum(['linked', 'unlinked'])
export type UplinkDesiredState = z.infer<typeof uplinkDesiredStateSchema>

/** What the host's own connector reports; never leaves the host. */
export const uplinkObservedStateSchema = z.enum(['online', 'offline', 'error'])
export type UplinkObservedState = z.infer<typeof uplinkObservedStateSchema>

export const uplinkLinkStateSchema = z.object({
  observed: uplinkObservedStateSchema,
  error: z.string().optional(),
})
export type UplinkLinkState = z.infer<typeof uplinkLinkStateSchema>

/** A `direct` route is dialed before the `tunnel`; an `http:` route is unusable from an `https:` page. */
export const hostRouteSchema = z.object({
  kind: z.enum(['direct', 'tunnel']),
  url: z.string().min(1),
})
export type HostRoute = z.infer<typeof hostRouteSchema>

/** One row of `GET /v1/hosts`: the tunnel route only; direct routes are the client's own knowledge. */
export const directoryHostSchema = z.object({
  hostId: z.string().min(1),
  installationId: z.string().min(1),
  label: z.string(),
  os: hostOperatingSystemSchema.optional().catch(undefined),
  routes: z.array(hostRouteSchema),
})
export type DirectoryHost = z.infer<typeof directoryHostSchema>

// ── `/v1` request and response bodies ────────────────────────────────────────

export const directoryResponseSchema = z.object({ hosts: z.array(directoryHostSchema) })

export const enrollmentTicketResponseSchema = z.object({
  /** One use, ten minutes. Handed to the host over an already-trusted local connection. */
  ticket: z.string().min(1),
  expiresAt: z.number(),
})
export type EnrollmentTicketResponse = z.infer<typeof enrollmentTicketResponseSchema>

export const enrollHostRequestSchema = z.object({
  ticket: z.string().min(1),
  installationId: z.string().min(1),
  label: z.string().min(1).max(120),
  os: hostOperatingSystemSchema.optional(),
  proxiedPort: z.number().int().min(1).max(65535),
})
export type EnrollHostRequest = z.infer<typeof enrollHostRequestSchema>

/** Returned once. The host stores both tokens in its secret store and never sees them again. */
export const enrollHostResponseSchema = z.object({
  link: uplinkLinkConfigSchema,
  /** `cloudflared` credential; tunnel only, never an API credential. */
  connectorToken: z.string().min(1),
  /** Lets the host read and delete its own link record. */
  hostToken: z.string().min(1),
})
export type EnrollHostResponse = z.infer<typeof enrollHostResponseSchema>

export const hostGrantResponseSchema = z.object({
  grant: z.string().min(1),
  hostId: z.string().min(1),
  expiresAt: z.number(),
})
export type HostGrantResponse = z.infer<typeof hostGrantResponseSchema>

/** `GET /v1/hosts/:id/link` with the host token: the generation check at boot. */
export const hostLinkResponseSchema = z.object({
  hostId: z.string().min(1),
  desired: uplinkDesiredStateSchema,
  connectionGeneration: z.number().int().nonnegative(),
  hostname: z.string().min(1),
  proxiedPort: z.number().int().positive(),
})
export type HostLinkResponse = z.infer<typeof hostLinkResponseSchema>

export const uplinkErrorCodeSchema = z.enum([
  'invalid_request',
  'unauthorized',
  'invalid_ticket',
  'invalid_host_token',
  'cross_origin',
  'host_not_found',
  'host_not_linked',
  'tunnel_provisioning_failed',
  'tunnel_not_configured',
  'tunnel_account_limit',
])
export type UplinkErrorCode = z.infer<typeof uplinkErrorCodeSchema>

/** Every `/v1` error body. */
export const uplinkErrorBodySchema = z.object({
  error: uplinkErrorCodeSchema.or(z.string()),
  message: z.string().optional(),
})

// ── Host RPC (local-owner only) ──────────────────────────────────────────────

/** The owner's client hands the host a ticket and tells it where the directory is. */
export interface UplinkLinkRequest {
  ticket: string
  /** The account origin that issued the ticket, e.g. `https://app.solus.sh`. */
  directoryUrl: string
}

export const uplinkStatusSchema = z.discriminatedUnion('linked', [
  z.object({ linked: z.literal(false) }),
  z.object({
    linked: z.literal(true),
    link: uplinkLinkConfigSchema,
    state: uplinkLinkStateSchema,
  }),
])
export type UplinkStatus = z.infer<typeof uplinkStatusSchema>

// ── Client shell (desktop main / cloud-served web) ───────────────────────────

/** What a client needs to link a host: the ticket and where it came from. */
export interface UplinkEnrollmentTicket extends EnrollmentTicketResponse {
  directoryUrl: string
}

/** The account's host directory, with the origin it belongs to. */
export interface UplinkDirectory {
  directoryUrl: string
  hosts: DirectoryHost[]
}
