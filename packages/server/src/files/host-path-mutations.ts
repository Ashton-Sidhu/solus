import { homedir } from 'os'
import { dirname } from 'path'
import { realpath, rename, rm } from 'fs/promises'
import type { HostPathMutation, HostPathMutationResult } from '@solus/contracts/types'
import { moveToTrash } from '../platform/trash'
import { expandHome } from './host-path'
import { friendlyMutationError } from './project-mutations'

/**
 * One edit the directory picker asks for, anywhere on the host. The picker
 * browses the whole machine, so the only fence is around the two folders whose
 * loss would take everything with them: the filesystem root and home.
 */
export async function applyHostPathMutation(mutation: HostPathMutation): Promise<HostPathMutationResult> {
  const target = expandHome(mutation.path)
  try {
    if (mutation.op === 'rename') {
      const destination = expandHome(mutation.toPath)
      // `rename` would replace an occupied destination without a word. A
      // case-only rename on a case-insensitive filesystem resolves to the
      // source itself, and that one is allowed through.
      const [occupant, source] = await Promise.all([
        realpath(destination).catch(() => null),
        realpath(target).catch(() => null),
      ])
      if (occupant && occupant !== source) {
        return { ok: false, error: 'Something with that name already exists here.' }
      }
      await rename(target, destination)
      return { ok: true, path: destination }
    }

    if (await isProtected(target)) {
      return { ok: false, error: 'Solus won’t remove your home folder or the filesystem root.' }
    }
    if (mutation.op === 'trash') {
      const outcome = await moveToTrash(target)
      if (outcome === 'unavailable') {
        return { ok: false, error: 'This host has no Trash for this location.', trashUnavailable: true }
      }
      return { ok: true, path: '' }
    }
    await rm(target, { recursive: true, force: true })
    return { ok: true, path: '' }
  } catch (error) {
    if (!(error instanceof Error)) return { ok: false, error: String(error) }
    return { ok: false, error: friendlyMutationError(error, error.message) }
  }
}

async function isProtected(target: string): Promise<boolean> {
  const resolved = await realpath(target).catch(() => target)
  const home = await realpath(homedir()).catch(() => homedir())
  return resolved === dirname(resolved) || resolved === home
}
