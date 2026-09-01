import { dirname, join } from 'path'
import { mkdir, realpath, rename, rm, writeFile as writeTextFile } from 'fs/promises'
import { z } from 'zod'
import type { ProjectFileMutation, ProjectFileMutationResult } from '@solus/contracts/types'
import { toRootRelativePath } from '../../../paths'

const filesystemErrorSchema = z.object({ code: z.string().optional() })

function friendlyMutationError(error: Error, fallback: string): string {
  const parsed = filesystemErrorSchema.safeParse(error)
  const code = parsed.success ? parsed.data.code : undefined
  if (code === 'EEXIST') return 'Something with that name already exists here.'
  if (code === 'ENOENT') return 'That location no longer exists.'
  if (code === 'EACCES' || code === 'EPERM') return 'You don’t have permission to change this location.'
  if (code === 'EISDIR' || code === 'ENOTDIR') return 'That name is already taken by a different kind of entry.'
  return fallback
}

/**
 * One structural edit inside `root`. Every path is re-derived from the root, so
 * a client cannot reach outside the project by sending `..` or an absolute path.
 * Creates never overwrite: the caller is told the name is taken instead.
 */
export async function applyProjectFileMutation(
  root: string,
  mutation: ProjectFileMutation,
): Promise<ProjectFileMutationResult> {
  try {
    return await runProjectFileMutation(root, mutation)
  } catch (error) {
    if (!(error instanceof Error)) return { ok: false, error: String(error) }
    return { ok: false, error: friendlyMutationError(error, error.message) }
  }
}

async function runProjectFileMutation(
  root: string,
  mutation: ProjectFileMutation,
): Promise<ProjectFileMutationResult> {
  const relativePath = toRootRelativePath(root, mutation.path)
  const target = join(root, relativePath)

  switch (mutation.op) {
    case 'createFile': {
      await mkdir(dirname(target), { recursive: true })
      // `wx` answers "already exists" atomically, where a stat-then-write could
      // still clobber a file another writer created in between.
      await writeTextFile(target, '', { flag: 'wx' })
      return { ok: true, path: relativePath }
    }
    case 'createFolder': {
      await mkdir(dirname(target), { recursive: true })
      // Non-recursive so an existing folder is EEXIST rather than a silent no-op.
      await mkdir(target)
      return { ok: true, path: `${relativePath}/` }
    }
    case 'rename': {
      const destinationRelative = toRootRelativePath(root, mutation.toPath)
      const destination = join(root, destinationRelative)
      await mkdir(dirname(destination), { recursive: true })
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
      return { ok: true, path: mutation.path.endsWith('/') ? `${destinationRelative}/` : destinationRelative }
    }
    case 'delete': {
      // `force` because the row can outlive the entry: an agent, a branch
      // switch, or the user's own editor may have removed it already, and the
      // pane's only job here is to end up with it gone.
      await rm(target, { recursive: true, force: true })
      return { ok: true, path: '' }
    }
  }
}
