import type { CodebaseFolderScan, CodebaseRoot } from '@solus/contracts/codebases'
import type { Place } from '@solus/contracts/types'
import { codebasesStore, type CodebaseHost } from '../../../contexts/codebases/codebases.store.svelte'
import { rootFor, rootRefusal, rootRefusalText, type CodebaseRootRefusal } from '@solus/client-core/codebases'

/**
 * The choice of one folder for a codebase, before it is a root: the host, the
 * folder, and what the host's scan found in it. A draft of one form: it is not
 * kept after the form closes.
 */
export class RootPickerState {
  /** The host the person chose. Null until they choose: the first ready host is used. */
  private chosenServerId = $state<string | null>(null)
  /** What the host found in the chosen folder. Its `path` is the resolved absolute path. */
  scan = $state<CodebaseFolderScan | null>(null)
  isScanning = $state(false)
  error = $state('')
  private scanCount = 0

  /** `existingRoots`: the roots that the codebase has now. A folder that is one of them, is inside one, or holds one is refused. */
  constructor(private readonly existingRoots: () => readonly CodebaseRoot[]) {}

  /** The hosts that can get a folder now: ready, and known by their installation id. */
  get hosts(): CodebaseHost[] {
    return codebasesStore.hosts.filter((host) => host.isReady && host.status === 'ready' && host.installationId !== null)
  }

  get host(): CodebaseHost | null {
    const hosts = this.hosts
    return hosts.find((host) => host.serverId === this.chosenServerId) ?? hosts[0] ?? null
  }

  chooseHost(serverId: string): void {
    if (serverId === this.host?.serverId) return
    this.chosenServerId = serverId
    this.clear()
  }

  /** Ask the chosen host what the folder holds. A newer ask replaces this one. */
  async scanFolder(path: string): Promise<void> {
    const host = this.host
    if (!host) return
    const count = ++this.scanCount
    this.chosenServerId = host.serverId
    this.scan = null
    this.error = ''
    this.isScanning = true
    try {
      const scan = await codebasesStore.scanFolder(host.serverId, path)
      if (count === this.scanCount) this.scan = scan
    } catch (error) {
      if (count === this.scanCount) this.error = error instanceof Error ? error.message : 'The host could not read the folder.'
    } finally {
      if (count === this.scanCount) this.isScanning = false
    }
  }

  /** Why the scanned folder cannot be added, or null when it can. */
  get refusal(): CodebaseRootRefusal | null {
    const host = this.host
    if (!this.scan || !host?.installationId) return null
    if (this.scan.state === 'missing') return 'missing'
    return rootRefusal(this.existingRoots(), { installationId: host.installationId, path: this.scan.path })
  }

  /** The folder to add: set only after a scan that found a folder that can be added. */
  get choice(): Place | null {
    const host = this.host
    return this.scan && host && !this.refusal ? { serverId: host.serverId, path: this.scan.path } : null
  }

  /** The chosen folder as the root that it becomes: none, or one. The second folder of a new codebase reads the first one here. */
  get chosenRoots(): CodebaseRoot[] {
    const host = this.host
    return this.scan && this.choice && host?.installationId ? [rootFor(host.installationId, this.scan)] : []
  }

  /** Why the scanned folder cannot be added, as one line, or null when it can. */
  get problemText(): string | null {
    if (this.error) return this.error
    const refusal = this.refusal
    if (refusal) return rootRefusalText(refusal)
    return this.choice ? null : 'The host could not read the folder.'
  }

  clear(): void {
    this.scanCount++
    this.scan = null
    this.error = ''
    this.isScanning = false
  }
}
