import type { IntegrationConnection } from '../integration-types'

/**
 * The person's environment values of a command in Settings
 * (docs/plans/mcp-first-class.md §7.6, §7.7), apart from the rest of the
 * command's rules in `command-server.ts`: the row's sign-in label reads it,
 * and that label is on the first screen.
 */

export interface CommandValuesText {
  text: string
  /** The names still to give, while none are saved. */
  detail: string | null
  /** The action that saves values; Disconnect removes them. */
  action: 'Enter values' | 'Change values'
  hasValues: boolean
}

/** The person's environment values of a command, in words. A value is never read back: only whether some are saved. */
export function commandValuesText(names: readonly string[], connection: Pick<IntegrationConnection, 'status'> | null | undefined): CommandValuesText {
  const hasValues = connection?.status === 'connected'
  const count = names.length === 1 ? '1 value' : `${names.length} values`
  return hasValues
    ? { text: `${count} saved on this host`, detail: null, action: 'Change values', hasValues }
    : { text: 'No values yet', detail: `The command needs ${names.join(', ')}.`, action: 'Enter values', hasValues }
}
