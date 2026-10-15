import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { z } from 'zod'
import { CHAT_ROOT_NAME } from '@solus/contracts/chat'
import { createLogger } from './logger'
import { getServerSettings } from './host/settings'
import { expandHome } from './files/host-path'
import { memberFolderFor } from './host/member-folders'
import { memberUsers } from './host/member-users'
import { applyMemberFiles } from './execution/seats/member-files'
import { solusDir } from './platform/paths'
import type { Principal } from './admission/principal'
import type { ProcessUser } from './cli-env'

/**
 * Where projects land on this host — where "New project" creates a folder and a
 * clone goes. Settings → General owns the answer; a host that never set one
 * falls back to `SOLUS_PROJECTS_ROOT` (the managed image's volume path,
 * managed-hosts.md §3) and then to `~/projects`, so new projects never land
 * loose in the home folder.
 */
export function setupProjectsRoot(
  settings: Pick<ReturnType<typeof getServerSettings>, 'projectsBaseDirectory'> = getServerSettings(),
  homeDirectory = homedir(),
  env: { SOLUS_PROJECTS_ROOT?: string } = process.env,
): string {
  const configured = settings.projectsBaseDirectory?.trim() || env.SOLUS_PROJECTS_ROOT?.trim()
  if (configured) return expandHome(configured, homeDirectory)
  return join(homeDirectory, 'projects')
}

const log = createLogger('main', 'workspace')

/** A chat id names a folder: nothing in it may walk the filesystem. */
const chatIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

/** A chat refused because the folder its chats go in is a Git repository. */
export class ChatUnavailableError extends Error {
  constructor(folder: string) {
    super(`Chats are off on this host: ${folder} is a Git repository.`)
    this.name = 'ChatUnavailableError'
  }
}

/**
 * Make the folder one chat runs in, `<home>/solus-chats/<chat id>`
 * (docs/plans/projectless-chat.md). Refused when `home` is itself a Git
 * repository: the agent there would read and change it. Only `home` is checked,
 * not its parents, so a repository in a parent folder (dotfiles in `~`) does not
 * turn chats off.
 */
export function makeChatFolder(home: string, chatId: string, member: ProcessUser | null = null): string {
  if (existsSync(join(home, '.git'))) {
    log.warn('chat_home_is_git_repository', { folder: home })
    throw new ChatUnavailableError(home)
  }
  const folder = join(home, CHAT_ROOT_NAME, chatIdSchema.parse(chatId))
  if (member) {
    // Made as the member, inside the `solus-chats` the host object made `<member>:solus 2750`
    // (docs/plans/member-isolation.md §5): theirs, readable by the server, closed to other members.
    applyMemberFiles(member, [{ kind: 'folder', path: folder, mode: 0o750 }])
  } else {
    mkdirSync(folder, { recursive: true })
  }
  return folder
}

/**
 * Where one person's projects land (managed-hosts.md §3). The host's root for its
 * owner and for the host's own work; a member of the organization gets a member
 * folder of their own beneath it, named after them (`host/member-folders.ts`), so each person clones
 * into a folder that is theirs and two people never share one main checkout. It is
 * a default and the member's view (`projectsVisibleTo`), not a boundary: a member
 * may still open a path a shared session names.
 */
export function projectsRootFor(principal: Principal | undefined, hostRoot = setupProjectsRoot()): string {
  if (principal?.kind !== 'org-member') return hostRoot
  const memberFolder = join(hostRoot, memberFolderFor(principal.userId, principal.displayName))
  // Where each member is their own user, the host object made it, theirs (docs/plans/member-isolation.md §5).
  if (!memberUsers()) mkdirSync(memberFolder, { recursive: true })
  return memberFolder
}

/**
 * The folder one chat runs in (docs/plans/projectless-chat.md): `solus-chats/<chat id>`
 * in the host's data folder, which is never a Git repository. A member's chats
 * stay in their own member folder, so another member's processes cannot reach them.
 */
export function chatFolderFor(chatId: string, principal: Principal | undefined, hostRoot = setupProjectsRoot()): string {
  if (principal?.kind !== 'org-member') return makeChatFolder(solusDir(), chatId)
  const user = memberUsers()?.userOf(principal.userId) ?? null
  return makeChatFolder(projectsRootFor(principal, hostRoot), chatId, user && { uid: user.uid })
}
