import { createAppContext } from '../app/create-app-context'
import type { ProjectConfig } from '../../../shared/types'
import type { HostApi } from '@client-core/host-api'
import { hostKey } from '@client-core/host-key'

export interface ProjectConfigHostContext {
  serverId: string
  api: HostApi
}

export class ProjectConfigStore {
  /** hostKey(serverId, projectRoot) -> config */
  byCwd = $state<Record<string, ProjectConfig | null>>({})

  async load(host: ProjectConfigHostContext, cwd: string): Promise<ProjectConfig | null> {
    if (!cwd || cwd === '~') return null
    const config = await host.api.projectConfigLoad(cwd)
    this.byCwd[hostKey(host.serverId, cwd)] = config
    return config
  }

  async save(host: ProjectConfigHostContext, cwd: string, patch: Partial<ProjectConfig>): Promise<ProjectConfig> {
    const key = hostKey(host.serverId, cwd)
    const current = this.byCwd[key] ?? { version: 1 as const }
    const next: ProjectConfig = {
      ...current,
      ...patch,
      version: 1,
    }
    this.byCwd[key] = next
    const saved = await host.api.projectConfigSave(cwd, next)
    this.byCwd[key] = saved
    return saved
  }

  configFor(serverId: string | null | undefined, cwd: string | null | undefined): ProjectConfig | null | undefined {
    if (!serverId || !cwd) return undefined
    return this.byCwd[hostKey(serverId, cwd)]
  }
}

export const [getProjectConfigStore, setProjectConfigStore] = createAppContext<ProjectConfigStore>('project-config')
