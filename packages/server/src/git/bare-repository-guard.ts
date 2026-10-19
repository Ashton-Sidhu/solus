/**
 * Git reads a repository Solus names (`--git-dir`, `GIT_DIR`) or finds through
 * a `.git` entry: a checkout, a linked worktree, a submodule. A bare repository
 * found only because the working directory is inside it is refused: its config
 * (hooks, fsmonitor, aliases) comes from whoever wrote that folder, such as a
 * project that embeds one. Command-line config is protected, so neither the
 * repository nor an inherited `GIT_CONFIG_*` setting can turn it back on.
 * Hooks inherit it. Git before 2.38 ignores the key.
 * (docs/adr/0002-git-bare-repository-discovery.md)
 */
const GUARD_ARGS = ['-c', 'safe.bareRepository=explicit'] as const

/** The arguments a process Solus starts gets: a `git` command gets the guard first. */
export function withBareRepositoryGuard(command: string, args: readonly string[]): string[] {
  return command === 'git' ? [...GUARD_ARGS, ...args] : [...args]
}
