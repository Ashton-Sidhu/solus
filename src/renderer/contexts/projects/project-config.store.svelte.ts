import { createContext } from 'svelte'
import type { ProjectConfig } from '../../../shared/types'

export class ProjectConfigStore {
  byCwd = $state<Record<string, ProjectConfig | null>>({})

  async load(cwd: string): Promise<ProjectConfig | null> {
    if (!cwd || cwd === '~') return null
    const config = await window.solus.projectConfigLoad(cwd)
    this.byCwd[cwd] = config
    return config
  }

  async save(cwd: string, patch: Partial<ProjectConfig>): Promise<ProjectConfig> {
    const current = this.byCwd[cwd] ?? { version: 1 as const }
    const next: ProjectConfig = {
      ...current,
      ...patch,
      version: 1,
    }
    this.byCwd[cwd] = next
    const saved = await window.solus.projectConfigSave(cwd, next)
    this.byCwd[cwd] = saved
    return saved
  }

  configFor(cwd: string | null | undefined): ProjectConfig | null | undefined {
    if (!cwd) return undefined
    return this.byCwd[cwd]
  }
}

export const [getProjectConfigStore, setProjectConfigStore] = createContext<ProjectConfigStore>()
