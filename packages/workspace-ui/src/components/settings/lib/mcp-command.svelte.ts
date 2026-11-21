import { SvelteMap } from 'svelte/reactivity'
import type { Integration, IntegrationEnvValue, IntegrationLaunch, IntegrationUpdateRequest } from '@solus/contracts/integration-types'
import { splitCommandLine } from '@solus/contracts/integrations/command-line'
import { checkCommandDraft, commandDraftOf, COMMAND_ADMIN_ONLY, parseEnvNames, type CommandDraftField } from '@solus/contracts/integrations/command-server'
import { mcpStore } from '../../../contexts/mcp'

export interface CommandFormProblem {
  field: CommandDraftField | 'form'
  reason: string
}

/** The environment variable names of a saved integration: none for a command without them. */
export function envNamesOf(integration: Pick<Integration, 'auth'>): string[] {
  return integration.auth.kind === 'env' ? integration.auth.names : []
}

function sameLaunch(a: IntegrationLaunch | undefined, b: IntegrationLaunch): boolean {
  return !!a && a.command === b.command && a.cwd === b.cwd && a.args.length === b.args.length && a.args.every((arg, index) => arg === b.args[index])
}

/**
 * The add or edit form of a command (docs/plans/mcp-first-class.md §7.7): the
 * line, the working directory, the environment variable names, and, when it
 * adds, the name and the values. Ephemeral: it lives as long as its dialog or
 * row editor. A person without `host.admin` gets the host's refusal in place of
 * the form, and nothing is sent (§7.2).
 *
 * The values are secrets. They stay in `values` only until `takeValues` hands
 * them to the host, which clears them.
 */
export class McpCommandForm {
  name = $state('')
  line = $state('')
  cwd = $state('')
  envNames = $state('')
  /** The typed value of each name, until `takeValues`. */
  readonly values = new SvelteMap<string, string>()
  problem = $state<CommandFormProblem | null>(null)
  isSaving = $state(false)

  constructor(
    private readonly serverId: string,
    private readonly mayRunCommands: () => boolean,
    /** The command to edit; absent to add one. Edit leaves the name to Rename. */
    readonly editing: Integration | null = null,
  ) {
    if (editing?.launch) {
      const draft = commandDraftOf(editing.launch, envNamesOf(editing))
      this.line = draft.line
      this.cwd = draft.cwd
      this.envNames = draft.envNames
    }
  }

  /** Why this person cannot add or change a command here, or null. */
  get refusal(): string | null {
    return this.mayRunCommands() ? null : COMMAND_ADMIN_ONLY
  }

  /** The program and its arguments as the host starts them, while the line reads; null for an empty or refused line. */
  get preview(): Pick<IntegrationLaunch, 'command' | 'args'> | null {
    const split = this.line.trim() ? splitCommandLine(this.line) : null
    return split?.ok ? split.launch : null
  }

  /** Why the typed line is refused, while the person types; nothing for an empty line. */
  get lineProblem(): string | null {
    if (!this.line.trim()) return null
    const split = splitCommandLine(this.line)
    return split.ok ? null : split.reason
  }

  /** The names that read, for the values fields. */
  get names(): string[] {
    const parsed = parseEnvNames(this.envNames)
    return parsed.ok ? parsed.names : []
  }

  /** The problem of one field, after a save was tried. */
  problemOf(field: CommandFormProblem['field']): string | null {
    return this.problem?.field === field ? this.problem.reason : null
  }

  /**
   * Takes the typed values out of the form: one for each name, or null when
   * none was typed. The form keeps no value after this call.
   */
  takeValues(): IntegrationEnvValue[] | null {
    const values = this.names.map((name) => ({ name, value: this.values.get(name) ?? '' }))
    this.values.clear()
    return values.some((value) => value.value.length > 0) ? values : null
  }

  /**
   * Adds the command, or saves the changes of the one it edits, or of `existing`
   * when a dialog already added it. Answers the record, or null with `problem` set.
   */
  async save(existing: Integration | null = this.editing): Promise<Integration | null> {
    const refusal = this.refusal
    if (refusal) {
      this.problem = { field: 'form', reason: refusal }
      return null
    }
    const check = checkCommandDraft({ name: this.editing ? undefined : this.name, line: this.line, cwd: this.cwd, envNames: this.envNames })
    if (!check.ok) {
      this.problem = { field: check.field, reason: check.reason }
      return null
    }
    this.problem = null
    const namesChanged = !existing || envNamesOf(existing).join('\u0000') !== check.envNames.join('\u0000')
    if (existing && sameLaunch(existing.launch, check.launch) && !namesChanged && (this.editing || existing.name === check.name)) return existing
    this.isSaving = true
    let saved: Integration | null
    if (existing) {
      const update: IntegrationUpdateRequest = { id: existing.id, launch: check.launch }
      if (namesChanged) update.envNames = check.envNames
      // The add dialog names the command; the row's editor leaves the name to Rename.
      if (!this.editing && existing.name !== check.name) update.name = check.name
      saved = await mcpStore.integrations.update(this.serverId, update)
    } else {
      saved = await mcpStore.integrations.create(this.serverId, { name: check.name, launch: check.launch, envNames: check.envNames })
    }
    this.isSaving = false
    if (!saved) {
      this.problem = { field: 'form', reason: mcpStore.integrations.states.get(this.serverId)?.writeError || 'The host did not save the command.' }
      mcpStore.integrations.clearWriteError(this.serverId)
    }
    return saved
  }
}
