import { Settings } from '@lucide/svelte'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { settingsByPage, type SettingItem } from '../../settings/lib/settings-search-data'
import { filterCommands, type Command } from './commands'

export function settingsSearchCommands(workspace: Pick<WorkspaceContext, 'showSettings'>, query: string): Command[] {
  if (!query) return []
  // SAFETY: settingsByPage is a static object, and Object.keys returns its own page keys.
  const tabs = Object.keys(settingsByPage) as (keyof typeof settingsByPage)[]
  const candidates = tabs.flatMap((tab) => settingsByPage[tab].map((setting: SettingItem): Command => ({
    id: `setting:${tab}:${setting.id}`,
    label: setting.label,
    group: 'Settings',
    icon: Settings,
    keywords: [tab, setting.description ?? '', ...setting.keywords],
    run: () => workspace.showSettings(tab, 'palette'),
  })))
  const shownLabels = new Set<string>()
  const matches: Command[] = []
  for (const command of filterCommands(candidates, query)) {
    if (shownLabels.has(command.label)) continue
    shownLabels.add(command.label)
    matches.push(command)
    if (matches.length === 5) break
  }
  return matches
}
