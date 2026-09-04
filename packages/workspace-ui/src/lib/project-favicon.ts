import { hostKey } from '@solus/client-core/host-key'
import type { HostApi } from '@solus/client-core/host-api'
import type { IpcContext } from '@solus/contracts/types'
import { assetUrlCache, type AssetUrlCache } from '../components/artifact/lib/asset-url'

/** Filenames a project may keep its own mark under, in the order we prefer. */
const FAVICON_FILENAMES = [
  'favicon.ico',
  'favicon.svg',
  'favicon.png',
  'favicon.webp',
  'favicon.jpg',
  'favicon.jpeg',
]

/** Common nested locations. Keep this list short: each miss is a host request,
 * and root-level files remain the unambiguous project-owned convention. */
const NESTED_FAVICON_PATHS = [
  'public/favicon.ico',
  'static/favicon.ico',
  'apps/web/public/favicon.ico',
]

export const PROJECT_FAVICON_SELECTION_TTL_MS = 5 * 60_000
const PROJECT_FAVICON_STORAGE_PREFIX = 'solus.project-favicon.v1:'

interface FaviconStorage {
  readonly length: number
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  key(index: number): string | null
}

export interface ProjectFaviconRequest {
  serverId: string
  projectRoot: string
  origin: string
  api: Pick<HostApi, 'assetCreateUrl'>
  ctx: IpcContext
}

/**
 * Finds each project's favicon on the host that owns the project, then asks
 * that host for a signed HTTP URL. A browser cannot load the Electron-only
 * `solus-artifact://` protocol, and a renderer path is not a client-local path.
 */
export class ProjectFaviconResolver {
  private readonly selectedPathByProject = new Map<string, string | null>()
  private readonly pendingByProject = new Map<string, Promise<string | null>>()

  constructor(
    private readonly assets: Pick<AssetUrlCache, 'resolve'> = assetUrlCache,
    private readonly storage: FaviconStorage | undefined = browserSessionStorage(),
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(request: ProjectFaviconRequest): Promise<string | null> {
    const projectKey = hostKey(request.serverId, normalizedRoot(request.projectRoot))
    const selectedPath = this.selectedPathByProject.get(projectKey)
    if (selectedPath === null) return null
    if (selectedPath) {
      try {
        return await this.resolvePath(request, selectedPath)
      } catch {
        this.selectedPathByProject.delete(projectKey)
      }
    }

    const candidates = faviconCandidatePaths(request.projectRoot)
    const storedIndex = this.storedSelection(projectKey, candidates.length)
    if (storedIndex === -1) {
      this.selectedPathByProject.set(projectKey, null)
      return null
    }
    if (storedIndex !== undefined) {
      try {
        const path = candidates[storedIndex]
        const url = await this.resolvePath(request, path)
        this.selectedPathByProject.set(projectKey, path)
        return url
      } catch {
        try { this.storage?.removeItem(this.storageKey(projectKey)) } catch {}
      }
    }

    const pending = this.pendingByProject.get(projectKey)
    if (pending) return pending

    const resolution = this.find(request, projectKey, candidates)
    this.pendingByProject.set(projectKey, resolution)
    try {
      return await resolution
    } finally {
      if (this.pendingByProject.get(projectKey) === resolution) {
        this.pendingByProject.delete(projectKey)
      }
    }
  }

  clear(): void {
    this.selectedPathByProject.clear()
    this.pendingByProject.clear()
    if (!this.storage) return
    try {
      for (let index = this.storage.length - 1; index >= 0; index--) {
        const key = this.storage.key(index)
        if (key?.startsWith(PROJECT_FAVICON_STORAGE_PREFIX)) this.storage.removeItem(key)
      }
    } catch {}
  }

  private async find(
    request: ProjectFaviconRequest,
    projectKey: string,
    candidates: string[],
  ): Promise<string | null> {
    for (let index = 0; index < candidates.length; index++) {
      const path = candidates[index]
      try {
        const url = await this.resolvePath(request, path)
        this.selectedPathByProject.set(projectKey, path)
        this.storeSelection(projectKey, index)
        return url
      } catch {}
    }
    this.selectedPathByProject.set(projectKey, null)
    this.storeSelection(projectKey, -1)
    return null
  }

  private storedSelection(projectKey: string, candidateCount: number): number | undefined {
    const key = this.storageKey(projectKey)
    let stored: string | null | undefined
    try {
      stored = this.storage?.getItem(key)
    } catch {
      return undefined
    }
    if (!stored) return undefined
    const separator = stored.indexOf(':')
    const expiresAt = Number(stored.slice(0, separator))
    const candidateIndex = Number(stored.slice(separator + 1))
    if (separator < 1
      || !Number.isFinite(expiresAt)
      || expiresAt <= this.now()
      || !Number.isInteger(candidateIndex)
      || candidateIndex < -1
      || candidateIndex >= candidateCount) {
      try { this.storage?.removeItem(key) } catch {}
      return undefined
    }
    return candidateIndex
  }

  private storeSelection(projectKey: string, candidateIndex: number): void {
    try {
      this.storage?.setItem(
        this.storageKey(projectKey),
        `${this.now() + PROJECT_FAVICON_SELECTION_TTL_MS}:${candidateIndex}`,
      )
    } catch {}
  }

  private storageKey(projectKey: string): string {
    return `${PROJECT_FAVICON_STORAGE_PREFIX}${projectKey}`
  }

  private resolvePath(request: ProjectFaviconRequest, path: string): Promise<string> {
    return this.assets.resolve({
      serverId: request.serverId,
      path,
      origin: request.origin,
      api: request.api,
      ctx: request.ctx,
    })
  }
}

function browserSessionStorage(): FaviconStorage | undefined {
  try {
    return globalThis.sessionStorage
  } catch {
    return undefined
  }
}

export function faviconCandidatePaths(projectRoot: string): string[] {
  const root = normalizedRoot(projectRoot)
  return [
    ...FAVICON_FILENAMES.map((name) => `${root}/${name}`),
    ...NESTED_FAVICON_PATHS.map((path) => `${root}/${path}`),
  ]
}

function normalizedRoot(projectRoot: string): string {
  return projectRoot.length > 1 ? projectRoot.replace(/\/+$/, '') : projectRoot
}

export const projectFaviconResolver = new ProjectFaviconResolver()
