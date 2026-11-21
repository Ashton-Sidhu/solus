import { rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { StorageRepositoryKind } from '../../data/storage-repository-name'
import { GitRepository, repositoryPath } from './git-repository'
import type { RepositoryProvider } from './repository-provider'

/** Private, bare repositories of one feature in a folder of the Solus data directory. On one machine it stands in for Artifacts. */
export class LocalGitRepositoryProvider implements RepositoryProvider {
  readonly storageScope: string
  constructor(private readonly root: string, private readonly kind: StorageRepositoryKind, private readonly signal?: AbortSignal) {
    this.storageScope = `file://${root}`
  }

  private named(repository: string): GitRepository {
    return new GitRepository(repositoryPath(this.root, this.kind, repository), { signal: this.signal, timeoutMs: 30_000 })
  }

  /** A person can see this error, so it does not show the Git command that failed. */
  private unavailable(): never {
    throw new Error(`The local ${this.kind} repository could not be read or initialized.`)
  }

  async remote(repository: string): Promise<{ url: string }> {
    const local = this.named(repository)
    await local.init().catch(() => this.unavailable())
    return { url: pathToFileURL(local.path).href }
  }

  async readFile(repository: string, commit: string, path: string): Promise<string> {
    return this.named(repository).readText(commit, path).catch(() => this.unavailable())
  }

  async remove(repository: string): Promise<void> {
    await rm(this.named(repository).path, { recursive: true, force: true })
  }
}
