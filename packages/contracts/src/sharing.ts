/**
 * Sharing — who may open a session or a work on one host
 * (docs/plans/multiplayer-sharing.md §3–§4). The host owns every row; the control
 * plane never learns what a resource is called. Zod is the contract so the share
 * dialog, the Lab, and the host decode one shape.
 */

import { z } from 'zod'
import type { User } from './user'

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

/** A single named row as the dialog shows it; the link is reported apart from the rows. */
export const shareGrantSchema = z.object({
  subject: shareNamedSubjectSchema,
  role: shareRoleSchema,
  grantedByUserId: z.string().min(1),
  createdAt: z.number(),
})
export type ShareGrant = z.infer<typeof shareGrantSchema>

export const shareListSchema = z.object({
  resource: shareResourceSchema,
  ownerUserId: z.string().min(1),
  grants: z.array(shareGrantSchema),
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
  grants: z.array(z.object({
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
  ownerUserId: string
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

export const SHARE_ERROR_CODES = ['FORBIDDEN', 'NOT_FOUND', 'NOT_SHARED', 'SEAT_REQUIRED'] as const
export type ShareErrorCode = (typeof SHARE_ERROR_CODES)[number]
