import { permissionsAllow } from '@solus/contracts/permissions'
import type { Integration } from '@solus/contracts/integration-types'
import { permissionsFor } from '../admission/access-policy'
import type { Principal } from '../admission/principal'

/**
 * Who may run a command (docs/plans/mcp-first-class.md §7.2, §7.8). A `stdio`
 * integration runs as code on the host, as the OS user of the Solus server, so
 * this is the one rule for each path that adds, changes, or starts one: a run,
 * an MCP App call, an app of Solus, Settings, and `integrationProcessStart`.
 * The gateway checks it at its one start (`openStdio`); the handlers check
 * `mayRunCommands` before they change a record.
 */

/**
 * The principal a start acts for. Null when the path has no person, such as
 * the host's own work or a read: such a path starts no command.
 */
export type CommandStarter = Principal | null

export const COMMAND_CHANGE_REFUSAL = 'Only an administrator of this host can add or change a command.'

/** The person holds `host.admin` on this host. */
export function mayRunCommands(principal: Principal): boolean {
  return permissionsAllow(permissionsFor(principal), 'host.admin')
}

/** Why `starter` may not start the command of `integration` for `personKey`, or null when it may. */
export function commandStartRefusal(integration: Pick<Integration, 'name' | 'ownerKey'>, personKey: string | null, starter: CommandStarter): string | null {
  if (personKey === null) return `${integration.name} is a command, and the host's own work starts no command.`
  if (personKey !== integration.ownerKey) return `${integration.name} runs only for the person who added it.`
  if (!starter) return `${integration.name} is a command, and this request acts for no person who can start it.`
  if (!mayRunCommands(starter)) return `${integration.name} is a command. Only an administrator of this host can start a command.`
  return null
}
