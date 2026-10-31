import { hostPathBaseName, sameHostPath } from '@solus/contracts/host-path'
import type { ProjectEntry } from '@solus/contracts/types'
import type { SettingsTab } from '../../../contexts/workspace/routing/route-registry'

/** Only pages with project-owned settings offer a project scope. */
export function supportsProjectScope(tab: SettingsTab): boolean {
  return tab === 'providers' || tab === 'source-control'
}

/** Keep a deep-linked folder available before the host has listed it. */
export function settingsProjectChoices(projects: ProjectEntry[], selected?: string | null) {
  const labels = projects.map((project) => project.folderName || hostPathBaseName(project.path) || project.path)
  const counts = new Map<string, number>()
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1)
  const choices = projects.map((project, index) => ({
    value: selected && sameHostPath(project.path, selected) ? selected : project.path,
    label: counts.get(labels[index]!)! > 1 ? `${labels[index]} · ${project.path}` : labels[index]!,
  }))
  if (selected && !choices.some((choice) => choice.value === selected)) choices.unshift({ value: selected, label: hostPathBaseName(selected) || selected })
  return [{ value: '', label: 'All projects' }, ...choices]
}
