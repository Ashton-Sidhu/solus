import type { Automation } from '../../../../shared/types'
import { hostKey } from '@client-core/host-key'
import { projectDirLabel } from '../../../lib/paths'
import { matchesOpenProjects } from '../../../lib/sessionUtils'

export interface AutomationProject {
  key: string
  projectPath: string
  serverId: string | null
  label: string
  roots: string[]
  count: number
}

interface ProjectRoots {
  key: string
  label: string
  roots: string[]
}

/** Build only the project choices represented by the complete automation list. */
export function automationProjects(
  automations: Automation[],
  openProjects: ProjectRoots[],
  workspacePath?: string,
  serverIdFor: (automation: Automation) => string | null = () => null,
  hostLabelFor: (serverId: string) => string = (serverId) => serverId,
): AutomationProject[] {
  const projects = new Map<string, AutomationProject>()

  for (const automation of automations) {
    const serverId = serverIdFor(automation)
    const openProject = openProjects.find((project) =>
      matchesOpenProjects(automation.action.cwd, project.roots),
    )
    const projectPath = openProject?.key ?? automation.action.cwd
    const key = hostKey(serverId ?? '', projectPath)
    const existing = projects.get(key)
    if (existing) {
      existing.count++
      continue
    }
    projects.set(key, {
      key,
      projectPath,
      serverId,
      label: openProject?.label ?? projectDirLabel(projectPath, workspacePath),
      roots: openProject?.roots ?? [automation.action.cwd],
      count: 1,
    })
  }

  const list = [...projects.values()]
  const labelCounts = new Map<string, number>()
  for (const project of list) {
    labelCounts.set(project.label, (labelCounts.get(project.label) ?? 0) + 1)
  }
  for (const project of list) {
    if (!project.serverId) continue
    if ((labelCounts.get(project.label) ?? 0) < 2) continue
    project.label = `${project.label} · ${hostLabelFor(project.serverId)}`
  }
  return list.sort((a, b) => a.label.localeCompare(b.label))
}

export function automationProject(
  automation: Automation,
  serverId: string | null,
  projects: AutomationProject[],
): AutomationProject | undefined {
  return projects.find(
    (project) =>
      project.serverId === serverId &&
      matchesOpenProjects(automation.action.cwd, project.roots),
  )
}
