// The one write of the person's task sources: the strip of sources and the
// add control both change them. The task source store reads the sources again
// when the setting changes (docs/tasks.md).
import type { PersonalSettings } from '@solus/contracts/settings'
import { toasts } from '../../../../lib/toasts'

type TaskSourceConfig = Pick<PersonalSettings, 'taskSources'>

/** The part of the settings context that the write needs. */
interface TaskSourceSettings {
  setPersonal(key: 'taskSources', value: PersonalSettings['taskSources']): boolean
}

/** Save a change of the sources. False when there is no change, or when the
 *  settings refuse it; a refusal is said in a toast. */
export function saveTaskSources(settings: TaskSourceSettings, patch: TaskSourceConfig | null): boolean {
  if (!patch) return false
  // Plain values: the settings store clones what it keeps.
  const isSaved = settings.setPersonal('taskSources', $state.snapshot(patch.taskSources))
  if (!isSaved) toasts.error("Couldn't save the task sources", { description: 'Solus refused the change.' })
  return isSaved
}
