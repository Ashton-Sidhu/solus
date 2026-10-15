/**
 * Sharing — who may open a session or a work on one host
 * (docs/plans/multiplayer-sharing.md §3–§4). The host owns every row; the control
 * plane never learns what a resource is called. Zod is the contract so the share
 * dialog, the Lab, and the host decode one shape.
 */

import { z } from 'zod'
import type { User } from './user'
import { hostRouteSchema } from './uplink'

/**
 * What can be shared. A task's share reaches everything in it: the task page and
 * every session and work linked to it, at the task's role (§3.4). A session or a
 * work shared on its own reaches only itself.
 */
export const shareResourceKindSchema = z.enum(['session', 'work', 'task'])
export type ShareResourceKind = z.infer<typeof shareResourceKindSchema>

export const shareResourceSchema = z.object({
  kind: shareResourceKindSchema,
  id: z.string().min(1),
})
export type ShareResource = z.infer<typeof shareResourceSchema>

/** `commenter` reads, comments, and gives a review decision on a work, but
 *  cannot edit it (docs/plans/work-review-and-live-editing.md). On a session
 *  or a task it is a viewer. */
export const shareRoleSchema = z.enum(['viewer', 'commenter', 'editor'])
export type ShareRole = z.infer<typeof shareRoleSchema>

/** What a principal may do with a resource, highest first. */
export const resourceRoleSchema = z.enum(['none', 'viewer', 'commenter', 'editor', 'owner'])
export type ResourceRole = z.infer<typeof resourceRoleSchema>

const RESOURCE_ROLE_RANK = { none: 0, viewer: 1, commenter: 2, editor: 3, owner: 4 } as const satisfies Record<ResourceRole, number>

export function resourceRoleAtLeast(role: ResourceRole, required: ResourceRole): boolean {
  return RESOURCE_ROLE_RANK[role] >= RESOURCE_ROLE_RANK[required]
}

export function higherResourceRole(a: ResourceRole, b: ResourceRole): ResourceRole {
  return RESOURCE_ROLE_RANK[a] >= RESOURCE_ROLE_RANK[b] ? a : b
}

/** A named subject: a person, a team, or the whole organization. */
export const shareNamedSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: z.string().min(1) }),
  z.object({ kind: z.literal('team'), id: z.string().min(1) }),
  z.object({ kind: z.literal('organization'), id: z.string().min(1) }),
])
export type ShareNamedSubject = z.infer<typeof shareNamedSubjectSchema>

/** Whom a row grants to. `everyone` is the link: anyone who holds its secret. */
export const shareSubjectSchema = z.discriminatedUnion('kind', [
  ...shareNamedSubjectSchema.options,
  z.object({ kind: z.literal('everyone') }),
])
export type ShareSubject = z.infer<typeof shareSubjectSchema>

/**
 * One ACL entry as the dialog shows it (docs/plans/access-model.md §1): a role
 * the owner gave to a person, a team, or the organization. The link is
 * reported apart from the entries.
 */
export const aclEntrySchema = z.object({
  subject: shareNamedSubjectSchema,
  role: shareRoleSchema,
  grantedByUserId: z.string().min(1),
  createdAt: z.number(),
})
export type AclEntry = z.infer<typeof aclEntrySchema>

export const shareListSchema = z.object({
  resource: shareResourceSchema,
  /** The owner's person key. */
  ownerKey: z.string().min(1),
  entries: z.array(aclEntrySchema),
  /** The caller's own standing, so the client can hide what it cannot do. */
  callerRole: resourceRoleSchema,
  /** A link exists (an `everyone` row). Its secret is here for the owner and editors, so
   *  the link is always at hand to copy; a viewer sees only that a link exists. Absent
   *  on a row made before the host kept secrets: regenerate to get one. */
  link: z.object({ role: shareRoleSchema, secret: z.string().min(1).optional() }).nullable(),
})
export type ShareList = z.infer<typeof shareListSchema>

/**
 * `shareSet`: the whole named list, and the link when `link` is present (`null`
 * role turns it off), written in one transaction. Without `link` the link stays.
 */
export const shareSetRequestSchema = z.object({
  resource: shareResourceSchema,
  entries: z.array(z.object({
    subject: shareNamedSubjectSchema,
    role: shareRoleSchema,
  })).max(200),
  link: z.object({ role: shareRoleSchema.nullable() }).optional(),
})
export type ShareSetRequest = z.infer<typeof shareSetRequestSchema>

/** `shareSetLink`: `null` turns the link off; `regenerate` invalidates the old secret. */
export const shareSetLinkRequestSchema = z.object({
  resource: shareResourceSchema,
  role: shareRoleSchema.nullable(),
  regenerate: z.boolean().optional(),
})
export type ShareSetLinkRequest = z.infer<typeof shareSetLinkRequestSchema>

/** The service stores the secret for editors to copy; admission compares its hash. */
export const shareLinkSchema = z.object({
  role: shareRoleSchema,
  secret: z.string().min(1),
})
export type ShareLink = z.infer<typeof shareLinkSchema>

export const shareTransferRequestSchema = z.object({
  resource: shareResourceSchema,
  toUserId: z.string().min(1),
})
export type ShareTransferRequest = z.infer<typeof shareTransferRequestSchema>

/** Sent to everyone who can see the resource after any change; the list is re-read. */
export interface ShareChangedEvent {
  resource: ShareResource
  /** Who changed it, for "Access removed by <name>"; absent when the host itself changed it. */
  changedBy?: User
  /** Subjects whose access this change removed; a client that is one of them shows the notice. */
  removedUserIds: string[]
}

/** What a link can open. A task has no link of its own: its organization sees it. */
export type GuestLinkResource = ShareResource & { kind: 'work' | 'session' }

export function isGuestLinkResource(resource: ShareResource): resource is GuestLinkResource {
  return resource.kind === 'work' || resource.kind === 'session'
}

/** Cloud resource links keep the bearer secret in the fragment. */
export interface GuestLink {
  resource: GuestLinkResource
  secret: string
}

const SHARE_PATHS = { work: 'w', session: 's' } as const

export function cloudShareUrl(origin: string, resource: GuestLinkResource, secret: string): string {
  return `${origin.replace(/\/$/, '')}/${SHARE_PATHS[resource.kind]}/${encodeURIComponent(resource.id)}#${secret}`
}

export function parseCloudShareLink(pathname: string, hash: string): GuestLink | null {
  const path = /^\/(w|s)\/([A-Za-z0-9_-]+)\/?$/.exec(pathname)
  const secret = /^#([A-Za-z0-9_-]{32,256})$/.exec(hash)
  if (!path || !secret) return null
  const kind = path[1] === 'w' ? 'work' : 'session'
  return { resource: { kind, id: path[2]! }, secret: secret[1]! }
}

/**
 * `POST /auth/share-link` on the Solus API (docs/plans/host-sharing.md §4.2): what a
 * link's secret opens and where its guest page dials first. `host` is the machine
 * that runs a mirrored session, with the routes the directory knows for it; null for
 * a resource no host runs. The page falls back to the API's own copy, read only,
 * when the host does not answer.
 */
export const shareLinkRequestSchema = z.object({ shareSecret: z.string().min(1).max(256) })
export type ShareLinkRequest = z.infer<typeof shareLinkRequestSchema>

/** The resolve door's 404 for a secret it does not know; a host's 404 on the same path carries no code. */
export const SHARE_LINK_UNKNOWN = 'SHARE_LINK_UNKNOWN'

export const shareLinkTargetSchema = z.object({
  resource: shareResourceSchema,
  role: shareRoleSchema,
  /** The resource's organization: a signed-in member of it opens the member link instead. */
  organizationId: z.string().min(1),
  host: z.object({ hostId: z.string().min(1), routes: z.array(hostRouteSchema) }).nullable(),
})
export type ShareLinkTarget = z.infer<typeof shareLinkTargetSchema>

export const SHARE_ERROR_CODES = ['FORBIDDEN', 'NOT_FOUND', 'NOT_SHARED', 'SEAT_REQUIRED', 'HOST_NOT_LINKED'] as const
export type ShareErrorCode = (typeof SHARE_ERROR_CODES)[number]
