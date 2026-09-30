/**
 * One person, as Solus knows them, and who or what did something
 * (plans/012-user-actor-and-activity.md §1, §2). Plain data: a user crosses IPC
 * and WebSocket and lives in Svelte `$state`.
 */

import { z } from 'zod'
import type { DocProviderId } from './docs'
import { PRESENCE_COLOR_COUNT } from './presence'
import type { TaskProviderId } from './task-types'
import type { AgentId } from './types'

/** The kind of person, and their id in that kind (U3). */
export type UserId =
  /** A Solus account: a member, a linked host's owner, or a signed-in guest. */
  | { kind: 'account'; accountId: string }
  /** This host's owner before they link an account; minted once per host. */
  | { kind: 'local'; localId: string }
  /** An anonymous link guest. */
  | { kind: 'guest'; guestId: string }

export interface User {
  id: UserId
  displayName: string
  email?: string
  avatarUrl?: string
}

/** Who or what did something (U6). `for` is the person an agent or an automation worked for. */
export type Attribution =
  | { kind: 'user'; user: User }
  /** `title` is the session's name when the thing was done, for a signature.
   *  `provider` is absent only on a record written before Solus stored it. */
  | { kind: 'agent'; sessionId: string; provider?: AgentId; title?: string; for?: User }
  | { kind: 'automation'; automationId: string; name?: string; for?: User }
  | { kind: 'upstream'; provider: DocProviderId | Exclude<TaskProviderId, 'local'> }
  | { kind: 'system' }

export const userIdSchema: z.ZodType<UserId> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account'), accountId: z.string().min(1) }),
  z.object({ kind: z.literal('local'), localId: z.string().min(1) }),
  z.object({ kind: z.literal('guest'), guestId: z.string().min(1) }),
])

export const userSchema: z.ZodType<User> = z.object({
  id: userIdSchema,
  displayName: z.string(),
  email: z.string().optional(),
  avatarUrl: z.string().optional(),
})

export const attributionSchema: z.ZodType<Attribution> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), user: userSchema }),
  z.object({
    kind: z.literal('agent'),
    sessionId: z.string(),
    provider: z.enum(['claude-code', 'codex', 'opencode']).optional(),
    title: z.string().optional(),
    for: userSchema.optional(),
  }),
  z.object({ kind: z.literal('automation'), automationId: z.string(), name: z.string().optional(), for: userSchema.optional() }),
  z.object({ kind: z.literal('upstream'), provider: z.enum(['gdrive', 'confluence', 'github', 'jira']) }),
  z.object({ kind: z.literal('system') }),
])

const LOCAL_PREFIX = 'local:'
const GUEST_PREFIX = 'guest:'

export function sameUser(a: UserId, b: UserId): boolean {
  return userKey(a) === userKey(b)
}

/**
 * The string for maps and rows: the bare account id, `local:<id>`, or
 * `guest:<id>`. Members and guests keep the strings their rows already hold.
 */
export function userKey(id: UserId): string {
  switch (id.kind) {
    case 'account':
      return id.accountId
    case 'local':
      return `${LOCAL_PREFIX}${id.localId}`
    case 'guest':
      return `${GUEST_PREFIX}${id.guestId}`
  }
}

/** The reverse of `userKey`. A string with no known prefix is an account id. */
export function parseUserKey(key: string): UserId {
  if (key.startsWith(LOCAL_PREFIX)) return { kind: 'local', localId: key.slice(LOCAL_PREFIX.length) }
  if (key.startsWith(GUEST_PREFIX)) return { kind: 'guest', guestId: key.slice(GUEST_PREFIX.length) }
  return { kind: 'account', accountId: key }
}

/**
 * The stable color a user gets in every avatar stack, caret, and cursor
 * (docs/plans/multiplayer-presence.md §2): an FNV-1a hash of the user key, so a
 * person keeps their color across hosts, restarts, and rooms, and adjacent ids
 * spread across the palette.
 */
export function userColorIndex(user: User): number {
  const key = userKey(user.id)
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % PRESENCE_COLOR_COUNT
}

/** Two letters for an avatar: the first and last word's initials, or the first two letters of one word. */
export function userInitials(user: User): string {
  const words = user.displayName.split(/[\s_\-.]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase()
}

const UPSTREAM_NAMES = {
  gdrive: 'Google Docs',
  confluence: 'Confluence',
  github: 'GitHub',
  jira: 'Jira',
} satisfies Record<Extract<Attribution, { kind: 'upstream' }>['provider'], string>

/**
 * Who did something, in words for a reader outside the product's own chrome (an
 * agent's prompt, a copied summary): a person's name, an agent's session name,
 * an automation's name, or the system. A client names people through `actorName`,
 * which also says "you".
 */
export function attributionLabel(attribution: Attribution): string {
  switch (attribution.kind) {
    case 'user': return attribution.user.displayName
    case 'agent': return attribution.title ?? 'Solus'
    case 'automation': return attribution.name ?? 'Automation'
    case 'upstream': return UPSTREAM_NAMES[attribution.provider]
    case 'system': return 'Solus'
  }
}
