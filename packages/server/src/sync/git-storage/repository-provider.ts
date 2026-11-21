/**
 * The place that holds the remote copy of each storage repository
 * (docs/adr/0004-shared-git-storage.md): Cloudflare Artifacts, or a folder of
 * bare repositories on this machine. A feature gives the repository name; the
 * provider knows where the repository is and who can reach it.
 */
export interface RepositoryProvider {
  /** Identifies the place. A record keeps it, so a later change of the configuration is refused and not ignored. */
  readonly storageScope: string
  /** The Git remote of a repository, made on the first call, with a token for that repository only. A local remote has no token. */
  remote(repository: string, access: 'read' | 'write'): Promise<{ url: string; token?: string }>
  /** One file at `commit`, read with no clone. More than `maxBytes` gives `RepositoryFileTooLargeError`. */
  readFile(repository: string, commit: string, path: string, maxBytes?: number): Promise<string>
  remove(repository: string): Promise<void>
}
