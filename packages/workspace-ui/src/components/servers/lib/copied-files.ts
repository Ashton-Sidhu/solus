import { COPIED_FILE_MAX_BYTES, type IgnoredProjectFile, type WorktreeIncludeChange } from '@solus/contracts/types'

/** Env files are the ignored files people almost always want on another host. */
const SUGGESTED_FILE_NAME = /^(?:\.env(?:\..+)?|\.envrc|\.dev\.vars)$/

export function isCopyable(file: IgnoredProjectFile): boolean {
  return file.byteLength <= COPIED_FILE_MAX_BYTES
}

/**
 * What the list starts with: what `.worktreeinclude` names, or, for a project
 * with no `.worktreeinclude` yet, its env files. A suggestion is only saved
 * when the person saves.
 */
export function initialSelection(files: readonly IgnoredProjectFile[], hasIncludeFile: boolean): Set<string> {
  const chosen = hasIncludeFile
    ? files.filter((file) => file.included)
    : files.filter((file) => isCopyable(file) && SUGGESTED_FILE_NAME.test(file.path.split('/').at(-1) ?? file.path))
  return new Set(chosen.map((file) => file.path))
}

/** The changes Save writes: each file whose box differs from `.worktreeinclude`. */
export function includeChanges(files: readonly IgnoredProjectFile[], chosen: ReadonlySet<string>): WorktreeIncludeChange[] {
  return files
    .filter((file) => file.included !== chosen.has(file.path))
    .map((file) => ({ path: file.path, included: chosen.has(file.path) }))
}
