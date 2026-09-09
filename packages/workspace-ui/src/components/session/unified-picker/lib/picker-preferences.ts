export type PickerResultType = 'all' | 'tasks' | 'sessions'

export const PICKER_RESULT_LABELS = {
  all: 'Sessions and tasks',
  tasks: 'Tasks',
  sessions: 'Sessions',
} satisfies Record<PickerResultType, string>

const RESULT_TYPE_KEY = 'solus-picker-result-type'

/** This preference belongs to the client, across projects and host connections. */
export function loadPickerResultType(): PickerResultType {
  try {
    const value = localStorage.getItem(RESULT_TYPE_KEY)
    return value === 'tasks' || value === 'sessions' ? value : 'all'
  } catch {
    return 'all'
  }
}

export function savePickerResultType(value: PickerResultType): void {
  try {
    localStorage.setItem(RESULT_TYPE_KEY, value)
  } catch {
    // Keep the current choice usable when browser storage is unavailable.
  }
}
