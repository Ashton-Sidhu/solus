import { basename, dirname, join } from 'path'
import { lstat, mkdir, readdir, realpath, rename, rm, writeFile as writeTextFile } from 'fs/promises'
import { z } from 'zod'
import type { ProjectFileMutation, ProjectFileMutationResult } from '@solus/contracts/types'
import { isInsideRoot, toRootRelativePath } from '../paths'

const filesystemErrorSchema = z.object({ code: z.string().optional() })

export function friendlyMutationError(error: Error, fallback: string): string {
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
 * a client cannot reach outside the project by sending `..` or an absolute path,
 * and a link inside the project cannot carry the edit out of it.
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
  const realRoot = await realpath(root)
  // A name the user types in the file tree loses stray outer whitespace.
  const rawPath = mutation.path.trim()
  const relativePath = toRootRelativePath(realRoot, rawPath)
  const target = await resolveInsideRoot(realRoot, relativePath, rawPath)

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
      const rawDestination = mutation.toPath.trim()
      const destinationRelative = toRootRelativePath(realRoot, rawDestination)
      const destination = await resolveInsideRoot(realRoot, destinationRelative, rawDestination)
      await mkdir(dirname(destination), { recursive: true })
      // `rename` would replace an occupied destination without a word.
      if (await isNameTaken(destination, target)) {
        return { ok: false, error: 'Something with that name already exists here.' }
      }
      await rename(target, destination)
      return { ok: true, path: mutation.path.endsWith('/') ? `${destinationRelative}/` : destinationRelative }
    }
    case 'delete': {
      // `force` because the row can outlive the entry: an agent, a branch
      // switch, or the user's own editor may have removed it already, and the
      // pane's only job here is to end up with it gone. A link is removed
      // itself; what it points to stays.
      await rm(target, { recursive: true, force: true })
      return { ok: true, path: '' }
    }
  }
}

/**
 * Whether `destination` names an entry other than `source`. Entries are
 * compared as entries, never through a link: two links to one file, or a file
 * and a link to it, are two names. A case-only rename on a case-insensitive
 * filesystem finds the source itself under the new name, which its folder
 * does not list; a hard link to the source is listed, so it is taken.
 */
async function isNameTaken(destination: string, source: string): Promise<boolean> {
  if (destination === source) return false
  const [occupant, entry] = await Promise.all([lstat(destination).catch(() => null), lstat(source).catch(() => null)])
  if (!occupant) return false
  const isSameEntry = !!entry && entry.ino === occupant.ino && entry.dev === occupant.dev && dirname(destination) === dirname(source)
  if (!isSameEntry) return true
  return (await readdir(dirname(destination))).includes(basename(destination))
}

/**
 * Where `relativePath` really is: its parent with every link resolved, joined
 * with its own name. The name itself is not followed: a link there is the
 * entry, so a create finds the name taken, and a rename or delete moves or
 * removes the link. A parent that resolves outside the project is refused.
 */
async function resolveInsideRoot(realRoot: string, relativePath: string, raw: string): Promise<string> {
  const lexical = join(realRoot, relativePath)
  const parent = await realExistingPath(dirname(lexical))
  if (!isInsideRoot(realRoot, parent)) throw new Error(`File path is outside the repository: ${raw}`)
  return join(parent, basename(lexical))
}

/** The real path of `path`, with only the part that exists resolved. The
 *  missing rest is created later, beneath that real part. */
async function realExistingPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    const parsed = filesystemErrorSchema.safeParse(error)
    if (!parsed.success || parsed.data.code !== 'ENOENT') throw error
    // A link whose target is gone is not missing: creating beneath it would
    // create its target, wherever that is.
    if (await lstat(path).then(() => true, () => false)) throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await realExistingPath(parent), basename(path))
  }
}
