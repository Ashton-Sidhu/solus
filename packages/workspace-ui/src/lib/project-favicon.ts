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

  constructor(private readonly assets: Pick<AssetUrlCache, 'resolve'> = assetUrlCache) {}

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

    const pending = this.pendingByProject.get(projectKey)
    if (pending) return pending

    const resolution = this.find(request, projectKey)
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
  }

  private async find(request: ProjectFaviconRequest, projectKey: string): Promise<string | null> {
    for (const path of faviconCandidatePaths(request.projectRoot)) {
      try {
        const url = await this.resolvePath(request, path)
        this.selectedPathByProject.set(projectKey, path)
        return url
      } catch {}
    }
    this.selectedPathByProject.set(projectKey, null)
    return null
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
