/**
 * Path math and list building for the Open project flow. Everything here is
 * host-agnostic: the host's platform is passed in, because the paths belong to
 * whichever machine the project is being opened on — never to this client.
 */
import { safeProjectDirName } from '@solus/contracts/project-folder-name'

/** What the user is opening — or, for `new`, creating. Decides which screen home hands off to. */
export type ProjectSource = 'local' | 'clone' | 'github' | 'new'

/**
 * The screens in the flow. There is no step for the machine: it is bound the
 * moment the flow opens and changed from the header chip, on any screen.
 */
export type OpenProjectStep = 'home' | 'browse' | 'destination' | 'cloning'

/** The subset of a server the flow needs; keeps the store free of the servers store. */
export interface HostOption {
  id: string
  label: string
  local: boolean
}

function separatorFor(platform: string | null | undefined): '/' | '\\' {
  return platform === 'win32' ? '\\' : '/'
}

/** Joins a host-absolute directory to a child name using that host's separator. */
export function joinHostPath(directory: string, name: string, platform?: string | null): string {
  const base = directory.replace(/[\\/]+$/, '')
  return `${base}${separatorFor(platform)}${name}`
}

/** Where "Create" makes a new project, named the way the host will name it;
 *  null until a name is typed. */
export function newProjectPath(parent: string, name: string, platform?: string | null): string | null {
  const trimmed = name.trim()
  return trimmed ? joinHostPath(parent, safeProjectDirName(trimmed), platform) : null
}
