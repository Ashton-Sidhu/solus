/**
 * The rule "a container root is never a project" for the project lists of
 * this client (docs/plans/codebases.md decision 14). The codebases store has
 * the answer, and the projects store asks it where it builds each list. This
 * module stands between the two: the projects store is loaded by code that
 * does not load the connection stores of the app, which the codebases store
 * reads.
 */
type ContainerRule = (serverId: string, path: string) => boolean

let provided: ContainerRule | null = null

/** The codebases store gives its rule when it is loaded. */
export function provideContainerRule(rule: ContainerRule): void {
  provided = rule
}

/** True when the folder is the container root of a live codebase. False before the codebases store is loaded: no codebase is known then. */
export function isContainerRootOnClient(serverId: string, path: string): boolean {
  return provided ? provided(serverId, path) : false
}
