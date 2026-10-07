import { NEW_CHAT_DIRECTORY, isChat } from '@solus/contracts/chat'
import type { Automation } from '@solus/contracts/types'
import type { ProjectPageScope } from '../../../contexts/projects/project-catalog'
import { CHAT_LABEL } from '../../../lib/paths'
import type { ListProjectOption } from '../../ui/list-page/list-page'

/**
 * The project an automation runs in (docs/plans/project-model.md §1): the
 * project its host and folder belong to, so one repository on two hosts is
 * one project. An automation with no project files under Chat, one choice
 * for every host: each run gets a new chat folder, so the saved marker is
 * what they share.
 */
export function automationProjectKey(
  cwd: string,
  serverId: string | null,
  projectKeyFor: (serverId: string, path: string) => string,
): string {
  if (isChat(cwd)) return NEW_CHAT_DIRECTORY
  return serverId ? projectKeyFor(serverId, cwd) : cwd
}

/**
 * The page's project selector: one row per project that holds an automation,
 * every other project a machine holds (to scope to a project before
 * automating it), and the project the page is scoped to, so the active row
 * always shows. Rows come from the shared row builder (`optionsFor`), so a
 * project has the name it has on every page. A row with no automation is the
 * history-only row — the only kind the selector offers to forget.
 */
export function automationProjectOptions(
  automationKeys: Iterable<string>,
  otherProjectKeys: Iterable<string>,
  optionsFor: (projectKeys: Iterable<string>) => ListProjectOption[],
): ListProjectOption[] {
  const automated = new Set(automationKeys)
  const keys = new Set([...automated, ...otherProjectKeys])
  const hasChat = keys.delete(NEW_CHAT_DIRECTORY)
  const options = optionsFor(keys)
  if (hasChat) {
    options.push({ key: NEW_CHAT_DIRECTORY, projectKey: NEW_CHAT_DIRECTORY, serverId: '', label: CHAT_LABEL, available: true })
  }
  for (const option of options) option.historyOnly = !automated.has(option.key)
  return options.sort((a, b) => a.label.localeCompare(b.label))
}

/** The automations a project scope shows: those whose project is the scope's
 *  project, on whichever host they run. */
export function automationsInScope(
  automations: Automation[],
  scope: ProjectPageScope,
  projectKeyOf: (automation: Automation) => string,
): Automation[] {
  if (scope.kind === 'all') return automations
  return automations.filter((automation) => projectKeyOf(automation) === scope.key)
}
