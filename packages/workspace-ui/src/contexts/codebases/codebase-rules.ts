/**
 * The answers of the codebases store for stores that cannot load it: the
 * projects store and the session sidebar store are loaded by code that does
 * not load the connection stores of the app, which the codebases store reads.
 * The codebases store gives its answers when it is loaded; before that, no
 * codebase is known.
 *
 * - The rule "a container root is never a project" for the project lists of
 *   this client (docs/plans/codebases.md decision 14).
 * - The codebase of an id, for the name that a session row shows in place of
 *   its project (§11d).
 */
import type { Codebase } from '@solus/contracts/codebases'
import type { Place } from '@solus/contracts/types'

interface CodebaseRules {
  isContainerRoot: (folder: Place) => boolean
  codebaseOf: (codebaseId: string) => Codebase | undefined
}

let provided: CodebaseRules | null = null

/** The codebases store gives its answers when it is loaded. */
export function provideCodebaseRules(rules: CodebaseRules): void {
  provided = rules
}

/** True when the folder is the container root of a live codebase. False before the codebases store is loaded. */
export function isContainerRootOnClient(folder: Place): boolean {
  return provided ? provided.isContainerRoot(folder) : false
}

/** The live codebase of an id. Undefined for a deleted codebase, for one this client has not read, and before the codebases store is loaded. */
export function codebaseOnClient(codebaseId: string): Codebase | undefined {
  return provided?.codebaseOf(codebaseId)
}
