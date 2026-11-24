import { lstat, mkdir, readdir, readlink, rm, rmdir, stat, symlink, unlink } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { isInsideRoot } from '../paths'

/**
 * The stand-in of a plain folder in a task folder (docs/plans/codebases.md
 * §7): a real folder that holds a link to each entry of the original. A link
 * is the original, so an edit through it changes the original. A repository is
 * thus never linked: its place stays empty until it gets a worktree, and the
 * folders on the way to it are real folders.
 */

const samePlace = (a: string, b: string): boolean => resolve(a) === resolve(b)

/** `.git` in a folder, as a directory (a repository) or a file (a linked worktree, a submodule). */
async function isCheckout(folder: string): Promise<boolean> {
  return (await lstat(join(folder, '.git')).catch(() => null)) !== null
}

/** Windows makes a folder link without a privilege only as a junction. POSIX ignores the type. */
async function linkTo(original: string, link: string): Promise<void> {
  const isFolder = (await stat(original).catch(() => null))?.isDirectory() ?? false
  await symlink(original, link, isFolder ? 'junction' : 'file')
}

/**
 * Make `folder` the stand-in of the plain folder `original`: a link for each
 * entry that has none. `unlinked` are the places below `original` that never
 * get a link: the repositories that get a worktree, and the member
 * repositories that do not. A folder on the way to one of them is a real
 * folder with its own links. `.git` and each entry that is a checkout get no
 * link. What is in `folder` already stays, so a second call puts back only
 * what is missing.
 */
export async function linkPlainFolder(original: string, folder: string, unlinked: readonly string[]): Promise<void> {
  await mkdir(folder, { recursive: true })
  for (const entry of await readdir(original, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const source = join(original, entry.name)
    const target = join(folder, entry.name)
    if (unlinked.some((place) => samePlace(place, source))) continue
    const present = await lstat(target).catch(() => null)
    if (unlinked.some((place) => isInsideRoot(source, place))) {
      // A link here would lead the links of the next level into the original.
      if (!present?.isSymbolicLink()) await linkPlainFolder(source, target, unlinked)
      continue
    }
    if (present) continue
    if (!entry.isFile() && await isCheckout(source)) continue
    await linkTo(source, target)
  }
}

/**
 * Make room for a checkout at `place` in the stand-in `folder` of `original`.
 * A link on the way to `place` becomes a real folder with links to the entries
 * of its original, and a link at `place` itself is removed. Answers the
 * command that puts the links back, for a checkout that was not made.
 */
export async function openPlaceInLinks(original: string, folder: string, place: string): Promise<() => Promise<void>> {
  const segments = relative(folder, place).split(sep)
  const originalPlace = join(original, ...segments)
  let restore = async (): Promise<void> => {}
  let current = folder
  let source = original
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    source = join(source, segment)
    const entry = await lstat(current).catch(() => null)
    // Git makes the folders that are not there.
    if (!entry) break
    if (!entry.isSymbolicLink()) continue
    const link = current
    const linkedTo = await readlink(link)
    await unlink(link)
    // The link was all there was, so each thing in the real folder is from this call.
    restore = async () => {
      await rm(link, { recursive: true, force: true })
      await linkTo(linkedTo, link)
    }
    // The folders below this one are made with it.
    if (index < segments.length - 1) await linkPlainFolder(source, link, [originalPlace])
    break
  }
  return restore
}

/**
 * Remove the links in `folder` and each folder that is then empty. A link is
 * only unlinked: its original stays. `kept` are places that are not entered:
 * the checkouts that stay. Answers the files that are real, thus that exist
 * only in the task folder; they stay, and so do the folders that hold them.
 */
export async function removeLinks(folder: string, kept: readonly string[]): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => null)
  if (!entries) return []
  const realFiles: string[] = []
  for (const entry of entries) {
    const path = join(folder, entry.name)
    if (kept.some((place) => samePlace(place, path))) continue
    if (entry.isSymbolicLink()) await unlink(path)
    // A checkout that nothing recorded is not entered: the links in it are its own.
    else if (entry.isDirectory() && !(await isCheckout(path))) realFiles.push(...await removeLinks(path, kept))
    else realFiles.push(path)
  }
  // The folder stays when a file or a kept checkout is in it.
  await rmdir(folder).catch(() => {})
  return realFiles
}
