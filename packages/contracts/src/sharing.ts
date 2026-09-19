/**
 * Sharing — who may open a session or a work on one host
 * (docs/plans/multiplayer-sharing.md §3–§4). The host owns every row; the control
 * plane never learns what a resource is called. Zod is the contract so the share
 * dialog, the Lab, and the host decode one shape.
 */

import { z } from 'zod'

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

export const shareRoleSchema = z.enum(['viewer', 'editor'])
export type ShareRole = z.infer<typeof shareRoleSchema>

/** What a principal may do with a resource, highest first. */
export const resourceRoleSchema = z.enum(['none', 'viewer', 'editor', 'owner'])
export type ResourceRole = z.infer<typeof resourceRoleSchema>

const RESOURCE_ROLE_RANK = { none: 0, viewer: 1, editor: 2, owner: 3 } as const satisfies Record<ResourceRole, number>

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

/**
 * A resource's owner id. `host-owner` stands for the personal host's owner when
 * the resource was created over a local connection, which knows no account id.
 */
export const HOST_OWNER_USER_ID = 'host-owner'

export const shareListSchema = z.object({
  resource: shareResourceSchema,
  ownerUserId: z.string().min(1),
  grants: z.array(shareGrantSchema),
  /** The caller's own standing, so the client can hide what it cannot do. */
  callerRole: resourceRoleSchema,
  /** Tasks whose share this resource inherits: a session or work reached through a
   *  shared task. Named so the dialog can say "also shared through <task>". */
  inheritedFrom: z.array(z.object({ taskId: z.string().min(1), title: z.string() })).optional(),
  /** A link exists (an `everyone` row). Its secret is here for the owner and editors, so
   *  the link is always at hand to copy; a viewer sees only that a link exists. Absent
   *  on a row made before the host kept secrets: regenerate to get one. */
  link: z.object({ role: shareRoleSchema, secret: z.string().min(1).optional() }).nullable(),
})
export type ShareList = z.infer<typeof shareListSchema>

/** `shareSet`: the whole list except the link, which has its own call. */
export const shareSetRequestSchema = z.object({
  resource: shareResourceSchema,
  grants: z.array(z.object({
    subject: shareNamedSubjectSchema,
    role: shareRoleSchema,
  })).max(200),
})
export type ShareSetRequest = z.infer<typeof shareSetRequestSchema>

/** `shareSetLink`: `null` turns the link off; `regenerate` invalidates the old secret. */
export const shareSetLinkRequestSchema = z.object({
  resource: shareResourceSchema,
  role: shareRoleSchema.nullable(),
  regenerate: z.boolean().optional(),
})
export type ShareSetLinkRequest = z.infer<typeof shareSetLinkRequestSchema>

/** The secret leaves the host exactly once, in this answer; only its hash is stored. */
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
  /** Who changed it, for "Access removed by <name>". */
  changedBy: { userId: string; displayName: string }
  /** Subjects whose access this change removed; a client that is one of them shows the notice. */
  removedUserIds: string[]
}

/** The share-link fragment: `#/h/<hostId>/s/<secret>`; the secret never reaches the cloud server. */
export function guestLinkFragment(hostId: string, secret: string): string {
  return `#/h/${hostId}/s/${secret}`
}

export interface GuestLink {
  hostId: string
  secret: string
}

/** The inverse of `guestLinkFragment`: null for any other hash, including a workspace route. */
export function parseGuestLinkFragment(hash: string): GuestLink | null {
  const match = /^#?\/h\/([A-Za-z0-9_-]+)\/s\/([A-Za-z0-9_-]+)\/?$/.exec(hash)
  return match ? { hostId: match[1]!, secret: match[2]! } : null
}

export const SHARE_ERROR_CODES = ['FORBIDDEN', 'NOT_FOUND', 'NOT_SHARED', 'SEAT_REQUIRED'] as const
export type ShareErrorCode = (typeof SHARE_ERROR_CODES)[number]
