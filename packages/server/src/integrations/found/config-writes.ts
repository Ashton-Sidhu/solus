import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { FoundPlace, IntegrationFoundChange } from '@solus/contracts/integration-types'
import { hostCliEnv, startableCommand } from '../../cli-env'

/**
 * The changes Solus makes to another tool's config file
 * (docs/plans/mcp-first-class.md §8.8): turn a server off or on for that tool,
 * or delete its entry. Each change goes through the tool's own writer where it
 * has one, so Solus does not race the tool on its own file: `claude mcp remove`
 * and `codex mcp remove` delete, Codex's app-server writes `enabled`. Claude
 * Code keeps no command for its per-project lists, and Cursor, VS Code, and
 * Claude Desktop none at all, so those files get one read, one change, and an
 * atomic rename. A change never writes a value of the person's: it removes an
 * entry or a name.
 */

/** A file of servers by name: the table Solus changes, and every other key as the file has it. */
const serverFileSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.json()).optional(),
  servers: z.record(z.string(), z.json()).optional(),
})

/** One project in `~/.claude.json`: the lists of the servers Claude Code does not load there, and its other keys. */
const claudeProjectSchema = z.looseObject({
  disabledMcpServers: z.array(z.string()).optional(),
  disabledMcpjsonServers: z.array(z.string()).optional(),
  enabledMcpjsonServers: z.array(z.string()).optional(),
})
type ClaudeProject = z.infer<typeof claudeProjectSchema>
type ClaudeProjectList = 'disabledMcpServers' | 'disabledMcpjsonServers' | 'enabledMcpjsonServers'

const claudeJsonSchema = z.looseObject({ projects: z.record(z.string(), claudeProjectSchema).optional() })

/** A CLI that does not answer in this time has failed. */
const CLI_TIMEOUT_MS = 30_000

export interface ConfigWriteDeps {
  /** Writes one key of a Codex config file through its app-server (`config/value/write`); absent where the host runs no Codex. */
  codexWrite?: (keyPath: string, value: boolean, filePath: string) => Promise<void>
  /** Runs a CLI with no shell. Tests give their own. */
  run?: (program: 'claude' | 'codex', args: string[], cwd: string) => Promise<void>
}

/** What a change needs to know besides the entry: the project whose lists Claude Code keeps, and the file of those lists. */
export interface ChangeContext {
  projectRoot: string | null
  /** `~/.claude.json` (or the one in `CLAUDE_CONFIG_DIR`): Claude Code keeps each project's turned-off servers there. */
  claudeJsonPath: string
  home: string
}

/** Whether `change` can be made to `place` at all, before any file is read (§8.8). */
export function canChange(place: FoundPlace, change: 'turn-off' | 'delete', projectRoot: string | null): boolean {
  if (change === 'turn-off') {
    if (place.file === 'codex-config') return !place.name.includes('.')
    // Claude Code turns a server off for one project; a chat has none.
    return (place.file === 'claude-json' || place.file === 'mcp-json') && projectRoot !== null
  }
  // `codex mcp remove` writes the user's file only.
  if (place.file === 'codex-config') return place.scope === 'user'
  return (place.file !== 'claude-json' && place.file !== 'mcp-json') || place.scope === 'user' || projectRoot !== null
}

export class ConfigWrites {
  constructor(private readonly deps: ConfigWriteDeps = {}) {}

  async apply(place: FoundPlace, change: IntegrationFoundChange, context: ChangeContext): Promise<void> {
    if (!canChange(place, change === 'delete' ? 'delete' : 'turn-off', context.projectRoot)) {
      throw new Error(`Solus cannot ${change === 'delete' ? 'delete' : 'turn off'} ${place.name} in ${place.path}.`)
    }
    if (change === 'delete') return this.delete(place, context)
    return this.setEnabled(place, change === 'turn-on', context)
  }

  private async delete(place: FoundPlace, context: ChangeContext): Promise<void> {
    switch (place.file) {
      case 'claude-json':
        // `local` is Claude Code's word for an entry under the project in its own file.
        return this.run('claude', ['mcp', 'remove', place.name, '--scope', place.scope === 'user' ? 'user' : 'local'], place.scope === 'user' ? context.home : this.projectRoot(context))
      case 'mcp-json':
        return this.run('claude', ['mcp', 'remove', place.name, '--scope', 'project'], this.projectRoot(context))
      case 'codex-config':
        return this.run('codex', ['mcp', 'remove', place.name], context.home)
      default:
        return editJson(place.filePath, serverFileSchema, (config) => {
          const table = place.file === 'vscode' ? config.servers : config.mcpServers
          if (!table || !(place.name in table)) throw new Error(`${place.name} is no longer in ${place.path}.`)
          delete table[place.name]
        })
    }
  }

  private async setEnabled(place: FoundPlace, enabled: boolean, context: ChangeContext): Promise<void> {
    if (place.file === 'codex-config') {
      if (!this.deps.codexWrite) throw new Error('Codex does not run on this host, so Solus cannot change its config.')
      return this.deps.codexWrite(`mcp_servers.${place.name}.enabled`, enabled, place.filePath)
    }
    // Claude Code keeps a server it does not load in the project's list; a `.mcp.json` one also needs its approval.
    const root = this.projectRoot(context)
    const [offList, onList]: [ClaudeProjectList, ClaudeProjectList | null] = place.file === 'mcp-json' ? ['disabledMcpjsonServers', 'enabledMcpjsonServers'] : ['disabledMcpServers', null]
    return editJson(context.claudeJsonPath, claudeJsonSchema, (config) => {
      config.projects ??= {}
      const project = (config.projects[root] ??= {})
      setMember(project, offList, place.name, !enabled)
      if (onList) setMember(project, onList, place.name, enabled)
    })
  }

  private projectRoot(context: ChangeContext): string {
    if (!context.projectRoot) throw new Error('This change needs a project.')
    return context.projectRoot
  }

  private run(program: 'claude' | 'codex', args: string[], cwd: string): Promise<void> {
    if (this.deps.run) return this.deps.run(program, args, cwd)
    const env = hostCliEnv()
    const command = startableCommand(program, env)
    return new Promise((resolve, reject) => {
      execFile(command.file, [...command.args, ...args], { cwd, env, timeout: CLI_TIMEOUT_MS, windowsHide: true }, (error, _stdout, stderr) => {
        if (!error) return resolve()
        const detail = String(stderr).trim().split('\n').at(-1) ?? ''
        reject(new Error(`\`${program} ${args.slice(0, 2).join(' ')}\` failed${detail ? `: ${detail}` : '.'}`))
      })
    })
  }
}

/** Adds `name` to the list at `key`, or takes it out; an empty list is removed. */
function setMember(project: ClaudeProject, key: ClaudeProjectList, name: string, isMember: boolean): void {
  const list = (project[key] ?? []).filter((item) => item !== name)
  if (isMember) list.push(name)
  if (list.length > 0) project[key] = list
  else delete project[key]
}

/**
 * One change to a JSON config file: read it, parse the keys Solus changes,
 * change them, and write it back with a rename in the same folder, so a reader
 * never sees half a file. Every other key is kept as it was. The real path is
 * written, so a link in a dotfiles checkout stays a link. The file keeps its
 * mode and gets a two-space indent.
 */
async function editJson<T>(path: string, schema: z.ZodType<T>, change: (config: T) => void): Promise<void> {
  const real = await realpath(path)
  const parsed = schema.safeParse(JSON.parse(await readFile(real, 'utf8')))
  if (!parsed.success) throw new Error(`${path} is not a config file Solus can change.`)
  change(parsed.data)
  const temporary = join(dirname(real), `.${randomUUID()}.solus-tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(parsed.data, null, 2)}\n`, { mode: (await stat(real)).mode })
    await rename(temporary, real)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
