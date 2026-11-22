import { Listeners } from '../../lib/listeners'
import { projectContext } from '../conversation/lib/ipc-context'
import type { HostConnection } from '../hosts/host-connections'
import { buildFileTree, type FileTree } from './lib/file-tree'

/**
 * A project's files, read from the host's index once per visit and shared by
 * every folder screen of that project. Read-only: the phone browses and reads.
 */

export interface ProjectFileIndex {
  tree: FileTree
  /** The host stopped listing at its index limit; some files are not shown. */
  truncated: boolean
}

export type ProjectFilesState =
  | { kind: 'idle' }
  | { kind: 'loading'; previous: ProjectFileIndex | null }
  | { kind: 'loaded'; index: ProjectFileIndex }
  | { kind: 'error'; message: string; previous: ProjectFileIndex | null }

const IDLE = { kind: 'idle' } as const

const filesKey = (hostId: string, projectPath: string) => `${hostId}\u0000${projectPath}`

export class ProjectFiles {
  readonly changes = new Listeners()
  private readonly states = new Map<string, ProjectFilesState>()
  private readonly requests = new Map<string, number>()
  private nextRequest = 0

  constructor(
    private readonly connectionFor: (hostId: string) => HostConnection | null,
    private readonly organizationId: () => string | null,
  ) {}

  stateOf = (hostId: string, projectPath: string): ProjectFilesState => this.states.get(filesKey(hostId, projectPath)) ?? IDLE

  async load(hostId: string, projectPath: string): Promise<void> {
    const key = filesKey(hostId, projectPath)
    const current = this.states.get(key) ?? IDLE
    const previous = current.kind === 'loaded' ? current.index : current.kind === 'idle' ? null : current.previous
    const connection = this.connectionFor(hostId)
    if (!connection) {
      this.set(key, { kind: 'error', message: 'This host cannot be reached now.', previous })
      return
    }
    const request = ++this.nextRequest
    this.requests.set(key, request)
    this.set(key, { kind: 'loading', previous })
    let next: ProjectFilesState
    try {
      const result = await connection.api.listProjectFiles(projectContext(projectPath, this.organizationId()), { cwd: projectPath, includeEmptyDirectories: true })
      next = result.ok
        ? { kind: 'loaded', index: { tree: buildFileTree(result.files, result.emptyDirectories), truncated: result.truncated } }
        : { kind: 'error', message: result.error, previous }
    } catch (error) {
      next = { kind: 'error', message: error instanceof Error ? error.message : String(error), previous }
    }
    if (this.requests.get(key) !== request || this.connectionFor(hostId) !== connection) return
    this.set(key, next)
  }

  forgetHost(hostId: string): void {
    for (const key of Array.from(this.states.keys())) if (key.startsWith(`${hostId}\u0000`)) this.states.delete(key)
    this.changes.notify()
  }

  private set(key: string, state: ProjectFilesState): void {
    this.states.set(key, state)
    this.changes.notify()
  }
}
