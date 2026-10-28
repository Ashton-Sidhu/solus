import { existsSync } from 'fs'
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'fs/promises'
import path from 'path'
import { COPIED_FILE_MAX_BYTES, COPIED_FILES_MAX_TOTAL_BYTES, type CopiedProjectFile, type IgnoredProjectFiles, type WorktreeIncludeChange } from '@solus/contracts/types'
import { isInsideRoot, toRootRelativePath } from '../paths'
import { runAsync } from './exec'

/**
 * A checkout's `.worktreeinclude`: the files git ignores that still go with the
 * work. A new worktree gets them from its checkout, and a Run on send copies
 * them into the clone on the other host (docs/run-on.md#copied-files).
 */
export const WORKTREE_INCLUDE_FILE = '.worktreeinclude'

/** The list a person picks from; more than this is not a list anyone reads. */
const IGNORED_FILES_LIST_LIMIT = 500

function nulSeparated(output: string): string[] {
  return output.split('\0').filter(Boolean)
}

/** The ignored files `.worktreeinclude` names, relative to the checkout. */
export async function worktreeIncludedPaths(projectPath: string, signal?: AbortSignal): Promise<string[]> {
  const includePath = path.join(projectPath, WORKTREE_INCLUDE_FILE)
  if (!existsSync(includePath)) return []
  const ignored = new Set(nulSeparated(await runAsync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], projectPath, { signal })))
  if (ignored.size === 0) return []
  const matched = nulSeparated(await runAsync('git', ['ls-files', '--others', '--ignored', `--exclude-from=${includePath}`, '-z'], projectPath, { signal }))
  return matched.filter((relativePath) => ignored.has(relativePath))
}

/**
 * The files git ignores, each with its size and whether it is included. A
 * folder git ignores whole, like `node_modules`, is one entry to git and is
 * left out: nobody copies it by hand.
 */
export async function listIgnoredProjectFiles(projectPath: string): Promise<IgnoredProjectFiles> {
  const entries = nulSeparated(await runAsync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], projectPath))
    .filter((entry) => !entry.endsWith('/'))
    .sort()
  const included = new Set(await worktreeIncludedPaths(projectPath))
  const listed = entries.slice(0, IGNORED_FILES_LIST_LIMIT)
  const files = await Promise.all(listed.map(async (relativePath) => {
    const info = await stat(path.join(projectPath, relativePath)).catch(() => null)
    return info?.isFile() ? { path: relativePath, byteLength: info.size, included: included.has(relativePath) } : null
  }))
  return {
    files: files.filter((file) => file !== null),
    truncated: entries.length > listed.length,
    hasIncludeFile: existsSync(path.join(projectPath, WORKTREE_INCLUDE_FILE)),
  }
}

/** The lines a pattern file uses for one exact path: `a/b` or the anchored `/a/b`. */
function namesPath(line: string, filePath: string): boolean {
  const trimmed = line.trim()
  return trimmed === filePath || trimmed === `/${filePath}`
}

/**
 * Takes out the lines that work against each change: the `!path` that hides a
 * file being included, and the `path` line of a file being left out. A pattern
 * that names more than one file stays; `setWorktreeIncluded` adds an exact line
 * when a pattern still decides against the change.
 */
export function withoutOpposingLines(text: string, changes: readonly WorktreeIncludeChange[]): string {
  const lines = text.split('\n')
  const kept = lines.filter((line) => !changes.some((change) => {
    const trimmed = line.trim()
    return change.included
      ? trimmed.startsWith('!') && namesPath(trimmed.slice(1), change.path)
      : namesPath(trimmed, change.path)
  }))
  return kept.join('\n')
}

/** Adds lines at the end, keeping one line break before each. */
export function withAppendedLines(text: string, lines: readonly string[]): string {
  if (lines.length === 0) return text
  const base = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`
  return `${base}${lines.join('\n')}\n`
}

/**
 * Includes or leaves out each file, changing as few lines as it can. The
 * patterns already there keep their meaning; when one of them still decides
 * against a change, an exact `/path` or `!/path` line settles it.
 */
export async function setWorktreeIncluded(projectPath: string, changes: readonly WorktreeIncludeChange[]): Promise<IgnoredProjectFiles> {
  const normalized = changes.map((change) => ({ path: toRootRelativePath(projectPath, change.path), included: change.included }))
  const includePath = path.join(projectPath, WORKTREE_INCLUDE_FILE)
  const current = await readFile(includePath, 'utf-8').catch(() => '')
  const cleared = withoutOpposingLines(current, normalized)
  if (cleared !== current) await writeFile(includePath, cleared)
  const included = new Set(await worktreeIncludedPaths(projectPath))
  const settling = normalized
    .filter((change) => included.has(change.path) !== change.included)
    .map((change) => (change.included ? `/${change.path}` : `!/${change.path}`))
  if (settling.length > 0 || !existsSync(includePath)) await writeFile(includePath, withAppendedLines(cleared, settling))
  return listIgnoredProjectFiles(projectPath)
}

/**
 * What a Run on send copies: every included file that fits, and the
 * `.worktreeinclude` itself, so worktrees the other host makes later get the
 * same files. A file over the size limit, or past the total, stays behind.
 */
export async function readWorktreeIncludedFiles(projectPath: string): Promise<CopiedProjectFile[]> {
  const includePath = path.join(projectPath, WORKTREE_INCLUDE_FILE)
  if (!existsSync(includePath)) return []
  const paths = [WORKTREE_INCLUDE_FILE, ...await worktreeIncludedPaths(projectPath)]
  const files: CopiedProjectFile[] = []
  let total = 0
  for (const relativePath of paths) {
    const info = await stat(path.join(projectPath, relativePath)).catch(() => null)
    if (!info?.isFile() || info.size > COPIED_FILE_MAX_BYTES || total + info.size > COPIED_FILES_MAX_TOTAL_BYTES) continue
    total += info.size
    files.push({ path: relativePath, contentBase64: (await readFile(path.join(projectPath, relativePath))).toString('base64') })
  }
  return files
}

/**
 * Writes each copied file that `root` lacks. A file already there is never
 * replaced: the agent, or a person, may have changed it on this host. Every
 * path comes from a client, so one that leaves the checkout or reaches into
 * `.git` is refused. Answers how many files it wrote.
 */
export async function writeMissingCopiedFiles(root: string, files: readonly CopiedProjectFile[]): Promise<number> {
  const realRoot = await realpath(root)
  let written = 0
  for (const file of files) {
    const relativePath = toRootRelativePath(root, file.path)
    if (relativePath.split('/')[0].toLowerCase() === '.git') throw new Error(`A copied file cannot be written inside .git: ${file.path}`)
    const target = path.join(root, relativePath)
    if (await lstat(target).then(() => true, () => false)) continue
    await mkdir(path.dirname(target), { recursive: true })
    // A folder in the checkout can be a link that leads out of it.
    if (!isInsideRoot(realRoot, await realpath(path.dirname(target)))) throw new Error(`A copied file is outside the checkout: ${file.path}`)
    await writeFile(target, Buffer.from(file.contentBase64, 'base64'), { flag: 'wx' })
    written += 1
  }
  return written
}
