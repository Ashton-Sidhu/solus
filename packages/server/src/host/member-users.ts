import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { z } from 'zod'
import { createLogger } from '../logger'

const log = createLogger('main', 'member-users')

/**
 * The Linux user of each member on a managed host (docs/plans/member-isolation.md
 * §4). The host object in the cloud names the users and keeps the table; its
 * script creates them, makes their folders, and writes this file last. The server
 * only reads it: a member in the file is ready, and their processes run as their
 * uid. The script also names the folders it made (`layout`, and each member's
 * `home` and `secrets`), so the server and the image cannot disagree about a path.
 * A host with no users file (every host but a managed one) runs every member as
 * the server's own user, with today's paths.
 */

/** Where the host object writes the file on a managed host; a Lab host names its own. */
const MANAGED_USERS_FILE = '/run/solus-managed/member-users.json'

/** The Linux name rule, which the host object's names keep. */
const usernameSchema = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/)

const absolutePathSchema = z.string().regex(/^\/[^\0]*$/)

const memberUserSchema = z.object({
  /** The member's account id: the key of their seats and records. */
  userId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  username: usernameSchema,
  /** The member switch runs their processes as this uid, with `solus-proj` as their group. */
  uid: z.number().int().positive(),
  /** Their `HOME`: kept, and in the host's backup. */
  home: absolutePathSchema,
  /** Their GitHub login files: in memory only, never in a backup. */
  secrets: absolutePathSchema,
})

/** The folders the script made for everyone (docs/plans/member-isolation.md §5). */
const layoutSchema = z.object({
  /** The member switch: the only program that starts a process as a member. */
  switch: absolutePathSchema,
  /** What the server hands to members: the bundled plugin, and files given to an agent by path. */
  shared: absolutePathSchema,
  /** Managed pull request review checkouts, which members' git works in. */
  reviews: absolutePathSchema,
})
const usersFileSchema = z.object({ layout: layoutSchema, users: z.array(memberUserSchema) })

export type MemberUser = z.infer<typeof memberUserSchema>
export type MemberLayout = z.infer<typeof layoutSchema>

/** What changed between two reads of the file. */
export interface MemberUsersChange {
  added: MemberUser[]
  removed: MemberUser[]
  /** The folders changed, or were named for the first time. */
  layoutChanged: boolean
}

export class MemberUsers {
  private users = new Map<string, MemberUser>()
  private currentLayout: MemberLayout | null = null
  private watcher: FSWatcher | null = null

  constructor(readonly path: string) {
    this.read()
  }

  /** The member's user, or null while the host object has not made it (or after it removed it). */
  userOf(userId: string): MemberUser | null {
    return this.users.get(userId) ?? null
  }

  /** The folders the script made, or null before the file exists. */
  layout(): MemberLayout | null {
    return this.currentLayout
  }

  /** The member whose user has this name, or null. */
  userNamed(username: string): MemberUser | null {
    for (const user of this.users.values()) if (user.username === username) return user
    return null
  }

  /**
   * Reads the file again and answers what changed. A missing file means no member
   * is ready yet; a file that does not parse keeps the last good read, so a bad
   * write never stops every member at once.
   */
  read(): MemberUsersChange {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch {
      // The folders stay where they were named: only the members are gone.
      return this.replace(new Map(), this.currentLayout)
    }
    let parsed: z.infer<typeof usersFileSchema>
    try {
      parsed = usersFileSchema.parse(JSON.parse(text))
    } catch (error) {
      log.error('member_users_file_invalid', { path: this.path, error: error instanceof Error ? error.message : String(error) })
      return { added: [], removed: [], layoutChanged: false }
    }
    return this.replace(new Map(parsed.users.map((user) => [user.userId, user])), parsed.layout)
  }

  /**
   * Watches the file's folder: the script replaces the file with a rename, which a
   * watch on the file itself would lose. Calls `onChange` only when a member came
   * or went, or the folders changed.
   */
  watch(onChange: (change: MemberUsersChange) => void): void {
    if (this.watcher) return
    const name = basename(this.path)
    try {
      this.watcher = watch(dirname(this.path), (_event, filename) => {
        if (filename !== null && filename !== name) return
        const change = this.read()
        if (change.added.length || change.removed.length || change.layoutChanged) onChange(change)
      })
    } catch (error) {
      log.error('member_users_watch_failed', { path: this.path, error: error instanceof Error ? error.message : String(error) })
    }
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
  }

  private replace(next: Map<string, MemberUser>, layout: MemberLayout | null): MemberUsersChange {
    const added = [...next.values()].filter((user) => !sameUser(this.users.get(user.userId), user))
    const removed = [...this.users.values()].filter((user) => !sameUser(next.get(user.userId), user))
    const layoutChanged = JSON.stringify(layout) !== JSON.stringify(this.currentLayout)
    this.users = next
    this.currentLayout = layout
    if (added.length || removed.length || layoutChanged) {
      log.info('member_users_changed', { added: added.map((user) => user.userId), removed: removed.map((user) => user.userId), layoutChanged })
    }
    return { added, removed, layoutChanged }
  }
}

function sameUser(a: MemberUser | undefined, b: MemberUser): boolean {
  return !!a && a.username === b.username && a.uid === b.uid && a.home === b.home && a.secrets === b.secrets
}

/** The users file of this host, or null where members share the server's user. */
export function memberUsersFilePath(): string | null {
  const named = process.env.SOLUS_MEMBER_USERS_FILE?.trim()
  if (named) return named
  return process.env.SOLUS_MANAGED_RUNTIME === 'cloudflare' ? MANAGED_USERS_FILE : null
}

let current: MemberUsers | null = null

/** Installed once at boot on a host with a users file; null everywhere else. */
export function useMemberUsers(users: MemberUsers | null): void {
  current = users
}

/** The installed member users, or null where members share the server's user. */
export function memberUsers(): MemberUsers | null {
  return current
}

export const WORKSPACE_PREPARING_CODE = 'WORKSPACE_PREPARING'

/** A member reached the host before the host object made their user. */
export class WorkspacePreparingError extends Error {
  readonly code = WORKSPACE_PREPARING_CODE

  constructor() {
    super('Setting up your workspace on this host for the first time. Try again in a moment.')
    this.name = 'WorkspacePreparingError'
  }
}
