import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { createLogger } from '../logger'

const log = createLogger('main', 'member-folders')

/**
 * The one folder name a member's things on this host live under: their projects
 * folder, their provider seats, their dispatch checkouts, and their Git
 * credentials. Everything else keys a member by their account id; only the
 * filesystem shows the name.
 *
 * A member's folder is their name and the start of their account id
 * (`ada-lovelace-k3x9q2`), so two people with one name are told apart by who
 * they are, not by who came first, and the folder still reads back to the
 * account in the cloud. The name is fixed in
 * `member_folder` the first time it is known and kept through a rename, so a
 * running process never loses its directory. A member who already had a folder
 * under their account id before folders were named keeps it: nothing is moved.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS member_folder (
  user_id TEXT PRIMARY KEY,
  folder TEXT NOT NULL UNIQUE
);
`

/** A Better Auth user id or a folder name; nothing that could walk the filesystem. */
export const memberFolderSegmentSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

const MAX_MEMBER_FOLDER_LENGTH = 48
/** How much of the account id a folder shows; more only when that much is already taken. */
const ID_SLUG_LENGTH = 6

/** `Ada Lovelace` → `ada-lovelace`: lowercase ASCII letters and digits, hyphens between words. Never empty. */
export function memberFolderName(name: string): string {
  const folder = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_MEMBER_FOLDER_LENGTH)
    .replace(/-+$/, '')
  return folder || 'member'
}

export interface MemberFoldersDeps {
  db: DatabaseSync
  /**
   * The directories a member folder sits in: the projects root and each seat
   * level. A name already used there is not free, and a folder already named by
   * the member's id there means they predate named folders.
   */
  roots: () => string[]
}

export class MemberFolders {
  private readonly folders = new Map<string, string>()
  private readonly userIds = new Map<string, string>()

  constructor(private readonly deps: MemberFoldersDeps) {
    deps.db.exec(SCHEMA)
  }

  /**
   * The member's folder. Without a name and with none recorded, the account id:
   * the folder is named the first time a caller knows who the member is.
   */
  folderOf(userId: string, name?: string): string {
    const safeUserId = memberFolderSegmentSchema.parse(userId)
    const recorded = this.recorded(safeUserId)
    if (recorded) return recorded
    if (!name?.trim()) return safeUserId
    const roots = this.deps.roots()
    const predates = roots.some((root) => existsSync(join(root, safeUserId)))
    const folder = predates ? safeUserId : this.freeFolder(memberFolderName(name), safeUserId, roots)
    this.deps.db.prepare('INSERT INTO member_folder (user_id, folder) VALUES (?, ?)').run(safeUserId, folder)
    this.remember(safeUserId, folder)
    log.info('member_folder_named', { userId: safeUserId, folder })
    return folder
  }

  /** The folder recorded for a key, or null; never names one. */
  recordedFolderOf(key: string): string | null {
    return memberFolderSegmentSchema.safeParse(key).success ? this.recorded(key) : null
  }

  /** The account a folder belongs to, or null for a folder no member holds. */
  userIdOf(folder: string): string | null {
    const cached = this.userIds.get(folder)
    if (cached) return cached
    const row = z.object({ user_id: z.string() }).nullish().parse(
      this.deps.db.prepare('SELECT user_id FROM member_folder WHERE folder = ?').get(folder),
    )
    if (!row) return null
    this.remember(row.user_id, folder)
    return row.user_id
  }

  private recorded(userId: string): string | null {
    const cached = this.folders.get(userId)
    if (cached) return cached
    const row = z.object({ folder: z.string() }).nullish().parse(
      this.deps.db.prepare('SELECT folder FROM member_folder WHERE user_id = ?').get(userId),
    )
    if (!row) return null
    this.remember(userId, row.folder)
    return row.folder
  }

  /**
   * `<name>-<id slug>`, the slug the start of the account id, lowercased. Ids
   * that differ only in case, or a folder already there, lengthen the slug; a
   * whole id still taken falls back to a counter.
   */
  private freeFolder(base: string, userId: string, roots: string[]): string {
    const taken = (folder: string) =>
      !!this.deps.db.prepare('SELECT 1 FROM member_folder WHERE folder = ?').get(folder)
      || roots.some((root) => existsSync(join(root, folder)))
    const id = userId.toLowerCase().replace(/[^a-z0-9]/g, '') || 'member'
    const named = (suffix: string) => `${base.slice(0, MAX_MEMBER_FOLDER_LENGTH - suffix.length - 1).replace(/-+$/, '')}-${suffix}`
    for (let length = ID_SLUG_LENGTH; length < id.length + ID_SLUG_LENGTH; length += ID_SLUG_LENGTH) {
      const candidate = named(id.slice(0, length))
      if (!taken(candidate)) return candidate
    }
    let attempt = 2
    while (taken(named(`${id.slice(0, ID_SLUG_LENGTH)}-${attempt}`))) attempt++
    return named(`${id.slice(0, ID_SLUG_LENGTH)}-${attempt}`)
  }

  private remember(userId: string, folder: string): void {
    this.folders.set(userId, folder)
    this.userIds.set(folder, userId)
  }
}

let current: MemberFolders | null = null

/** Installed once at boot; with none (a test, a tool), every member folder is the account id. */
export function useMemberFolders(folders: MemberFolders | null): void {
  current = folders
}

export function memberFolderFor(userId: string, name?: string): string {
  return current ? current.folderOf(userId, name) : memberFolderSegmentSchema.parse(userId)
}

/**
 * The folder a member already has, for a path that only reads one back (a
 * dispatch checkout, a Git credential file); any other key, such as a paired
 * device's, is returned as it is.
 */
export function recordedMemberFolder(key: string): string {
  return current?.recordedFolderOf(key) ?? key
}

/** The inverse of `memberFolderFor`: a folder no member holds reads back as itself. */
export function memberUserIdOf(folder: string): string {
  return current?.userIdOf(folder) ?? folder
}
