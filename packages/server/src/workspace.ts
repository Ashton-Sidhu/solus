import { homedir } from 'os'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { z } from 'zod'
import { ownerChatFolder } from './platform/paths'
import { getServerSettings } from './server/settings'
import { expandHome } from './server/handlers/lib/host-path'

/** The owner's chat folder — where a session with no project runs (Scratchpad). */
export const WORKSPACE_DIR = ownerChatFolder()

/** A Better Auth user id; nothing that could walk the filesystem. It names a member folder. */
export const memberFolderUserIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

/** The chat folder's name inside a member folder. A dot folder, so a folder picker hides it. */
export const MEMBER_CHAT_FOLDER_NAME = '.chat'

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

/**
 * True for a folder a session with no project runs in: the owner's chat folder, a
 * member's chat folder under this host's projects root, or a folder inside one.
 * It needs no principal: every chat folder has a fixed place.
 */
export function isChatFolder(path: string | null | undefined, hostRoot = setupProjectsRoot()): boolean {
  if (!path) return false
  if (path === '~') return true
  const insideOwnerChatFolder = relative(WORKSPACE_DIR, resolve(path))
  if (insideOwnerChatFolder === '' || (!insideOwnerChatFolder.startsWith('..') && !isAbsolute(insideOwnerChatFolder))) return true
  const [memberFolderName, chatFolderName] = relative(hostRoot, resolve(path)).split(sep)
  return chatFolderName === MEMBER_CHAT_FOLDER_NAME && memberFolderUserIdSchema.safeParse(memberFolderName).success
}
