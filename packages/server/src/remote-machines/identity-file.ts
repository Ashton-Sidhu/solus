import { chmodSync, statSync, type Stats } from 'node:fs'
import { resolveHomePath } from '../platform/paths'

/**
 * The identity file an SSH add names, checked on this host before `ssh` runs
 * (docs/ssh-machines.md, "Identity file"). A missing file and a key that other
 * users can read are the two mistakes `ssh` reports least clearly; a key
 * downloaded from a cloud console is often the second.
 */
export type IdentityFileCheck =
  | { status: 'ok' }
  | { status: 'missing'; message: string }
  | { status: 'too-open'; message: string }

/** Other users may read or write it: `ssh` refuses such a private key. */
const OPEN_TO_OTHERS = 0o077

function statOf(path: string): Stats | null {
  try { return statSync(path) } catch { return null }
}

export function checkIdentityFile(identityFile: string, hostName: string, platform: NodeJS.Platform = process.platform): IdentityFileCheck {
  const stats = statOf(resolveHomePath(identityFile))
  if (!stats?.isFile()) return { status: 'missing', message: `No file at ${identityFile} on ${hostName}. Choose the private key on ${hostName}.` }
  // Windows keeps file access in ACLs, and its OpenSSH checks those, not mode bits.
  if (platform !== 'win32' && (stats.mode & OPEN_TO_OTHERS) !== 0) {
    return { status: 'too-open', message: `Other users on ${hostName} can read ${identityFile}, so SSH refuses it. Fix permissions to let only you read it.` }
  }
  return { status: 'ok' }
}

/** Lets only this user read and write the key (chmod 600). Only a file this user owns: never another user's file. */
export function fixIdentityFilePermissions(identityFile: string, uid: number | null = process.getuid?.() ?? null): void {
  const path = resolveHomePath(identityFile)
  const stats = statOf(path)
  if (!stats?.isFile()) throw new Error(`No file at ${identityFile}.`)
  if (uid !== null && stats.uid !== uid) throw new Error(`${identityFile} belongs to another user, so Solus does not change it.`)
  chmodSync(path, 0o600)
}
