import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { z } from 'zod'
import { chatFolderIn } from '@solus/contracts/chat'
import { createLogger } from './logger'
import { getServerSettings } from './host/settings'
import { expandHome } from './files/host-path'

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

/** A chat refused because its folder would be inside a Git work tree. */
export class ChatUnavailableError extends Error {
  constructor() {
    super('Chats are off on this host: its projects folder is inside a Git repository.')
    this.name = 'ChatUnavailableError'
  }
}

/**
 * Make the folder one chat runs in, in a projects root (docs/plans/projectless-chat.md).
 * Refused when the root is inside a Git work tree: an agent there would read and
 * change that repository.
 */
export function makeChatFolder(projectsRoot: string, chatId: string): string {
  if (isInsideGitWorkTree(projectsRoot)) throw new ChatUnavailableError()
  const folder = chatFolderIn(projectsRoot, chatIdSchema.parse(chatId))
  mkdirSync(folder, { recursive: true })
  return folder
}

/** Per folder: the answer does not change while the host runs. */
const gitWorkTreeFolders = new Map<string, boolean>()

/** True when a `.git` entry sits in the folder or above it. No git process. */
function isInsideGitWorkTree(folder: string): boolean {
  const known = gitWorkTreeFolders.get(folder)
  if (known !== undefined) return known
  let inside = false
  for (let dir = resolve(folder); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) {
      inside = true
      break
    }
    if (dirname(dir) === dir) break
  }
  gitWorkTreeFolders.set(folder, inside)
  if (inside) log.warn('chat_root_in_git_worktree', { folder })
  return inside
}
