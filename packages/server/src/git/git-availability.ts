import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { findOnPath, getCliPath } from '../cli-env'

/** A missing git is checked again after this long, so an install is seen without a restart. */
const RECHECK_MS = 60_000
/**
 * On macOS this is a stub until the Command Line Tools are installed. Running it
 * then fails and asks macOS to open the "Install developer tools" dialog, so the
 * stub is never run to find out whether git works.
 */
const MACOS_GIT_STUB = '/usr/bin/git'

let isUsable = false
let checkedAt = 0

export class GitUnavailableError extends Error {
  constructor() {
    super('git is not installed on this host.')
    this.name = 'GitUnavailableError'
  }
}

/**
 * Whether git can run on this host. A found git is remembered for the life of
 * the process; a missing one is checked again after `RECHECK_MS`, or at once
 * when `recheck` is set (the setup readiness probe, after an install).
 */
export function isGitUsable(options: { recheck?: boolean; now?: number } = {}): boolean {
  if (isUsable) return true
  const now = options.now ?? Date.now()
  if (!options.recheck && checkedAt && now - checkedAt < RECHECK_MS) return false
  checkedAt = now
  isUsable = probeGit(process.platform, getCliPath())
  return isUsable
}

/** Exported for its test. */
export function probeGit(
  platform: NodeJS.Platform,
  path: string,
  developerDirectory: () => string | null = macDeveloperDirectory,
): boolean {
  const gitPath = findOnPath('git', path)
  if (!gitPath) return false
  if (platform !== 'darwin' || gitPath !== MACOS_GIT_STUB) return true
  // The stub forwards to the git inside the active developer directory: the
  // Command Line Tools or Xcode. `xcode-select -p` names it without the dialog.
  const directory = developerDirectory()
  return !!directory && existsSync(join(directory, 'usr', 'bin', 'git'))
}

function macDeveloperDirectory(): string | null {
  try {
    return execFileSync('xcode-select', ['-p'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

export function resetGitUsableForTests(): void {
  isUsable = false
  checkedAt = 0
}
