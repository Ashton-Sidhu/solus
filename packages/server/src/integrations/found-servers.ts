import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type {
  ConfigFileKind,
  FoundFile,
  FoundServer,
  FoundServerList,
  FoundTransport,
  Integration,
  IntegrationFoundAddRequest,
  IntegrationFoundAddResult,
  IntegrationFoundListRequest,
  IntegrationLaunch,
} from '@solus/contracts/integration-types'
import { recordScopeOf, type Principal } from '../admission/principal'
import { getCliPath } from '../cli-env'
import { createLogger } from '../logger'
import { isInsideRoot } from '../paths'
import { resolveHomePath } from '../platform/paths'
import { resolveProjectKey, resolveProjectRoot } from '../project-config/project-config'
import { foundUnsupportedText } from '@solus/contracts/integrations/found-server-labels'
import { COMMAND_CHANGE_REFUSAL, mayRunCommands } from './command-admission'
import type { IntegrationConnections } from './connections'
import { codexServers } from './found/codex-servers'
import { readConfigFile } from './found/config-file'
import { NO_SECRETS, type ConfigEntry, type EntrySecrets } from './found/config-entry'
import { jsonServers, parseJsonConfig, serverTableOf, type JsonConfig } from './found/json-servers'
import type { IntegrationGateway } from './gateway'
import { createIntegration, createStdioIntegration, probeForWrite, updateCommand, type IntegrationCreateDeps } from './integration-create'
import type { IntegrationStore } from './integration-store'
import { stdioServerAddress } from './stdio-process'
import { sameServerAddress } from './cli-skips'

const log = createLogger('integrations', 'found-servers.ts')

/** At most this much of one config file is read (docs/plans/mcp-first-class.md §8.1). */
const MAX_CONFIG_FILE_BYTES = 1024 * 1024
/** Claude Code also keeps each project's state in `~/.claude.json`, so on a busy machine it grows past 1 MB. It is the person's own file. */
const MAX_CLAUDE_JSON_BYTES = 8 * 1024 * 1024
/** A list answer is kept this long; Refresh and an add read the files again (§8.6). */
const LIST_CACHE_MS = 10_000
const LIST_CACHE_ENTRIES = 16

export interface FoundServersDeps {
  store: IntegrationStore
  events: IntegrationCreateDeps['events']
  profile?: IntegrationCreateDeps['profile']
  gateway: Pick<IntegrationGateway, 'forget' | 'invalidate'>
  connections: Pick<IntegrationConnections, 'removeAllFor' | 'submitEnvironment' | 'submitKey'>
  /** The Codex config layers for a folder (`config/read`), from the host's own app-server; absent where the host runs no Codex. */
  codexLayers?: (cwd: string | null) => Promise<unknown[]>
  /** The home folder of the Solus server's OS user and its environment. Tests give their own. */
  home?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  now?: () => number
}

/** One config file Solus may read: where it is, the folder no link may leave, and its size limit. */
interface ConfigFileSpot {
  file: ConfigFileKind
  path: string
  folder: string
  maxBytes: number
}

/** The entries of the files one caller may see, and the files that are there. */
interface FileRead {
  entries: ConfigEntry[]
  files: FoundFile[]
}

/** Entries of one address, merged: the same command in two files is one found server. */
interface MergedEntry {
  key: string
  first: ConfigEntry
  places: ConfigEntry['place'][]
  transport: FoundTransport | null
  expands: boolean
  valuesInFile: Set<string>
  secrets: EntrySecrets
}

/**
 * The MCP servers in the config files of this host (docs/plans/mcp-first-class.md
 * §8): one reader for each file kind under `found/`, the merge by address, the
 * state of each found server for the caller, and the add. It reads on request,
 * keeps an answer for 10 seconds, and has no file watcher. Nothing is added
 * without the person's add: a command in a cloned repository is code that
 * would run on the host.
 *
 * Who sees what (§8.1): a project's files, for a person who may use the
 * project; the files of the host's OS user, for a person with `host.admin`,
 * who may run a command as that user anyway. A member's own seat home is not
 * read.
 */
export class FoundServers {
  private readonly cache = new Map<string, { at: number; read: FileRead }>()

  constructor(private readonly deps: FoundServersDeps) {}

  async list(principal: Principal, ownerKey: string | null, request: IntegrationFoundListRequest): Promise<FoundServerList> {
    const where = this.whereFor(principal, request.projectPath)
    const read = await this.cachedRead(where, request.refresh === true)
    return { servers: this.foundServers(read.entries, principal, ownerKey, where).map(({ server }) => server), files: read.files }
  }

  /**
   * Reads the files again and adds what the person saw (§8.3), or takes the
   * change of a `changed` one. Another fingerprint adds nothing. A command
   * needs `host.admin` and does not start.
   */
  async add(principal: Principal, ownerKey: string, request: IntegrationFoundAddRequest): Promise<IntegrationFoundAddResult> {
    const where = this.whereFor(principal, request.projectPath)
    const read = await this.readFiles(where)
    this.cache.delete(where.cacheKey)
    const found = this.foundServers(read.entries, principal, ownerKey, where).find(({ server }) => server.foundId === request.foundId)
    if (!found || found.server.fingerprint !== request.fingerprint) return { kind: 'found-changed' }
    const { server, merged } = found
    if (server.state === 'added') throw new Error(`${server.name} is already added.`)
    if (server.unsupported === 'not-allowed') throw new Error(COMMAND_CHANGE_REFUSAL)
    if (server.state === 'unsupported' || !server.transport) throw new Error(`${server.name} cannot be added. ${foundUnsupportedText(server.unsupported ?? 'invalid')}`)
    const existing = server.integrationId ? this.deps.store.getOwned(server.integrationId, recordScopeOf(principal), ownerKey) : null
    const projectPath = server.projectOnly ? where.projectRoot ?? undefined : undefined
    const integration = server.transport.kind === 'stdio'
      ? this.saveCommand(principal, ownerKey, server, server.transport, existing, projectPath)
      : await this.saveUrl(principal, ownerKey, server, server.transport.kind === 'http' ? server.transport.url : '', existing, projectPath)
    const copied = request.useFileValues ? await this.copyValues(integration, ownerKey, merged.secrets) : 0
    // Names and counts only: a command, an argument, or a value can hold a secret.
    log.info('integration_found_added', { integrationId: integration.id, files: server.foundIn.map((place) => place.file), project: server.projectOnly, changed: existing !== null, copiedValues: copied })
    return { kind: 'saved', integration }
  }

  private saveCommand(principal: Principal, ownerKey: string, server: FoundServer, transport: Extract<FoundTransport, { kind: 'stdio' }>, existing: Integration | null, projectPath: string | undefined): Integration {
    if (!mayRunCommands(principal)) throw new Error(COMMAND_CHANGE_REFUSAL)
    const launch: IntegrationLaunch = { command: transport.command, args: transport.args }
    if (transport.cwd) launch.cwd = transport.cwd
    if (!existing) return createStdioIntegration(this.deps, principal, ownerKey, { name: server.name, launch, envNames: transport.envNames, projectPath })
    // A project command keeps running in its project when the file names no folder (§8.4).
    launch.cwd ??= existing.launch?.cwd
    const names = existing.auth.kind === 'env' ? existing.auth.names : []
    const sameNames = names.length === transport.envNames.length && names.every((name) => transport.envNames.includes(name))
    return updateCommand(this.deps, existing, { launch, envNames: sameNames ? undefined : transport.envNames }, principal)
  }

  private async saveUrl(principal: Principal, ownerKey: string, server: FoundServer, url: string, existing: Integration | null, projectPath: string | undefined): Promise<Integration> {
    if (!existing) return createIntegration(this.deps, principal, ownerKey, { name: server.name, url }, projectPath ? resolveProjectKey(projectPath) : undefined)
    const probe = await probeForWrite(url)
    const integration = this.deps.store.update(existing.id, { url, auth: probe.auth }, recordScopeOf(principal))
    if (!integration) throw new Error('That integration is no longer on this host.')
    this.deps.gateway.invalidate(existing.id)
    void this.deps.events.broadcast('integration.changed', { integrationId: existing.id, change: 'updated' })
    if (integration.projectKey === undefined) void this.deps.profile?.saved(principal, integration)
    return integration
  }

  /**
   * The file's plain values become the person's connection, on the host
   * (§8.3, step 4). A command takes them only when the file gives a value for
   * each of its names; otherwise the values form asks for all of them. A
   * server at a URL takes a fixed Authorization header as the person's key
   * when the probe decided `bearer`. The number copied, never a value.
   */
  private async copyValues(integration: Integration, ownerKey: string, secrets: EntrySecrets): Promise<number> {
    if (integration.auth.kind === 'env') {
      const names = integration.auth.names
      if (!names.every((name) => secrets.env.has(name))) return 0
      this.deps.connections.submitEnvironment(integration, ownerKey, names.map((name) => ({ name, value: secrets.env.get(name) ?? '' })))
      return names.length
    }
    if (integration.auth.kind !== 'bearer' || !secrets.authorization) return 0
    try {
      await this.deps.connections.submitKey(integration, ownerKey, secrets.authorization.replace(/^(bearer|basic)\s+/i, ''))
      return 1
    } catch (error) {
      // The server is added; the person enters a key that works when they connect.
      log.warn('integration_found_key_refused', { integrationId: integration.id, error: error instanceof Error ? error.message : String(error) })
      return 0
    }
  }

  /** What one caller may read: their project's files, and the user files for `host.admin`. */
  private whereFor(principal: Principal, projectPath: string | undefined) {
    const readsUserFiles = mayRunCommands(principal)
    const projectRoot = projectPath ? resolveProjectRoot(resolveHomePath(projectPath)) : null
    return { readsUserFiles, projectRoot, cacheKey: `${readsUserFiles ? 'user' : 'project'}\u0000${projectRoot ?? ''}` }
  }

  private async cachedRead(where: ReturnType<FoundServers['whereFor']>, refresh: boolean): Promise<FileRead> {
    const now = this.now()
    const cached = this.cache.get(where.cacheKey)
    if (!refresh && cached && now - cached.at < LIST_CACHE_MS) return cached.read
    const read = await this.readFiles(where)
    // The cache keeps names only: the values the files hold are read again at an add.
    const kept: FileRead = { files: read.files, entries: read.entries.map((entry) => ({ ...entry, secrets: NO_SECRETS })) }
    this.cache.delete(where.cacheKey)
    this.cache.set(where.cacheKey, { at: now, read: kept })
    while (this.cache.size > LIST_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value ?? '')
    return kept
  }

  private async readFiles(where: ReturnType<FoundServers['whereFor']>): Promise<FileRead> {
    const read: FileRead = { entries: [], files: [] }
    const { projectRoot } = where
    if (projectRoot) {
      for (const spot of this.projectFiles(projectRoot)) await this.readJsonFile(read, spot, 'project')
    }
    if (where.readsUserFiles) {
      for (const spot of this.userFiles()) {
        if (spot.file === 'claude-json') await this.readClaudeJson(read, spot, projectRoot)
        else await this.readJsonFile(read, spot, 'user')
      }
    }
    await this.readCodex(read, where)
    return read
  }

  private async readJsonFile(read: FileRead, spot: ConfigFileSpot, scope: 'user' | 'project'): Promise<void> {
    const config = await this.parsedFile(read, spot, scope)
    if (!config) return
    const entries = jsonServers(serverTableOf(config, spot.file), { kind: 'file', file: spot.file, scope, path: this.displayPath(spot.path) })
    read.entries.push(...entries)
    read.files.push({ file: spot.file, scope, path: this.displayPath(spot.path), servers: entries.length })
  }

  /** Claude Code's file holds the user's servers, and each project's own under its path (`projects["<path>"]`). */
  private async readClaudeJson(read: FileRead, spot: ConfigFileSpot, projectRoot: string | null): Promise<void> {
    const config = await this.parsedFile(read, spot, 'user')
    if (!config) return
    const path = this.displayPath(spot.path)
    const entries = jsonServers(config.mcpServers, { kind: 'file', file: 'claude-json', scope: 'user', path })
    const project = projectRoot ? config.projects?.[projectRoot] : undefined
    if (project) entries.push(...jsonServers(project.mcpServers, { kind: 'file', file: 'claude-json', scope: 'project', path }))
    read.entries.push(...entries)
    read.files.push({ file: 'claude-json', scope: 'user', path, servers: entries.length })
  }

  /** The parsed file, or null when it is not there or could not be read; a file that could not be read is listed with why. */
  private async parsedFile(read: FileRead, spot: ConfigFileSpot, scope: 'user' | 'project'): Promise<JsonConfig | null> {
    const path = this.displayPath(spot.path)
    let file
    try {
      file = await readConfigFile(spot.path, spot.folder, spot.maxBytes)
    } catch {
      file = { kind: 'refused' as const, reason: 'Solus could not read it.' }
    }
    if (file.kind === 'absent') return null
    if (file.kind === 'refused') {
      read.files.push({ file: spot.file, scope, path, servers: 0, problem: file.reason })
      return null
    }
    const parsed = parseJsonConfig(file.text)
    if (!parsed.ok) {
      read.files.push({ file: spot.file, scope, path, servers: 0, problem: parsed.problem })
      return null
    }
    return parsed.config
  }

  /** Codex reads its own files and applies its own rule for a trusted project (§8.1). */
  private async readCodex(read: FileRead, where: ReturnType<FoundServers['whereFor']>): Promise<void> {
    if (!this.deps.codexLayers || (!where.readsUserFiles && !where.projectRoot)) return
    let layers: unknown[]
    try {
      layers = await this.deps.codexLayers(where.projectRoot)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A host with no Codex has no Codex files to show.
      if (/ENOENT|not found|not installed/i.test(message)) return
      log.warn('integration_found_codex_unread', { error: message })
      read.files.push({ file: 'codex-config', scope: where.readsUserFiles ? 'user' : 'project', path: '~/.codex/config.toml', servers: 0, problem: 'Codex did not answer, so its config was not read.' })
      return
    }
    for (const layer of codexServers(layers, (path) => this.displayPath(path))) {
      if (layer.scope === 'user' ? !where.readsUserFiles : !where.projectRoot) continue
      read.entries.push(...layer.entries)
      read.files.push({ file: 'codex-config', scope: layer.scope, path: layer.path, servers: layer.entries.length })
    }
  }

  /** The found servers of these entries, for this caller, with the merged entry each came from. */
  private foundServers(entries: ConfigEntry[], principal: Principal, ownerKey: string | null, where: ReturnType<FoundServers['whereFor']>): Array<{ server: FoundServer; merged: MergedEntry }> {
    const integrations = this.deps.store.list(recordScopeOf(principal), ownerKey)
    const projectKey = where.projectRoot ? resolveProjectKey(where.projectRoot) : null
    return mergeByAddress(entries)
      .map((merged) => ({ merged, server: this.foundServer(merged, integrations, principal, projectKey, where.projectRoot) }))
      .sort((a, b) => a.server.name.localeCompare(b.server.name) || a.server.foundId.localeCompare(b.server.foundId))
  }

  private foundServer(merged: MergedEntry, integrations: Integration[], principal: Principal, projectKey: string | null, projectRoot: string | null): FoundServer {
    const projectOnly = merged.places.every((place) => place.scope === 'project')
    const transport = merged.transport
    const server: FoundServer = {
      foundId: hash(JSON.stringify([merged.key, projectOnly ? projectKey : null])),
      fingerprint: hash(JSON.stringify([merged.transport, projectOnly, merged.expands])),
      name: merged.first.place.name,
      foundIn: merged.places,
      transport,
      state: 'new',
      projectOnly,
      valuesInFile: [...merged.valuesInFile],
    }
    if (!transport) return { ...server, state: 'unsupported', unsupported: 'invalid' }
    const unsupported = transport.kind === 'sse' ? 'sse' : merged.expands ? 'expansion' : null
    if (unsupported) return { ...server, state: 'unsupported', unsupported }
    // The address rule of the CLI skip (§8.5): a server shown as added is one whose CLI copy a run leaves out.
    const added = integrations.find((integration) => transport.kind === 'stdio'
      ? integration.url === merged.key
      : integration.kind === 'mcp' && sameServerAddress({ kind: 'url', url: integration.url }, { kind: 'url', url: transport.url }))
    if (added) return { ...server, state: 'added', integrationId: added.id }
    if (transport.kind === 'stdio') {
      if (!mayRunCommands(principal)) return { ...server, state: 'unsupported', unsupported: 'not-allowed' }
      if (!findsProgram(transport.command, transport.cwd ?? (projectOnly && projectRoot ? projectRoot : '~'))) server.commandMissing = true
    }
    // Added from this entry before, by its name, kind, and scope, with another command or URL now.
    const scopeKey = projectOnly ? projectKey ?? undefined : undefined
    const changed = integrations.find((integration) => integration.name === server.name && integration.kind === (transport.kind === 'stdio' ? 'stdio' : 'mcp') && integration.projectKey === scopeKey)
    return changed ? { ...server, state: 'changed', integrationId: changed.id } : server
  }

  /** The files of a project (§8.1). No link may leave the project's root. */
  private projectFiles(root: string): ConfigFileSpot[] {
    return [
      { file: 'mcp-json', path: join(root, '.mcp.json'), folder: root, maxBytes: MAX_CONFIG_FILE_BYTES },
      { file: 'cursor', path: join(root, '.cursor', 'mcp.json'), folder: root, maxBytes: MAX_CONFIG_FILE_BYTES },
      { file: 'vscode', path: join(root, '.vscode', 'mcp.json'), folder: root, maxBytes: MAX_CONFIG_FILE_BYTES },
    ]
  }

  /**
   * The files of the Solus server's OS user (§8.1). Claude Code keeps
   * `.claude.json` in `CLAUDE_CONFIG_DIR` when it is set. VS Code keeps the
   * default profile's `mcp.json` in its user folder; Claude Desktop its config
   * in its application folder.
   */
  private userFiles(): ConfigFileSpot[] {
    const home = this.home()
    const env = this.deps.env ?? process.env
    const platform = this.deps.platform ?? process.platform
    const claudeDir = env.CLAUDE_CONFIG_DIR?.trim()
    const appData = platform === 'win32' ? env.APPDATA?.trim() || join(home, 'AppData', 'Roaming') : platform === 'darwin' ? join(home, 'Library', 'Application Support') : env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
    return [
      claudeDir
        ? { file: 'claude-json', path: join(claudeDir, '.claude.json'), folder: claudeDir, maxBytes: MAX_CLAUDE_JSON_BYTES }
        : { file: 'claude-json', path: join(home, '.claude.json'), folder: home, maxBytes: MAX_CLAUDE_JSON_BYTES },
      { file: 'cursor', path: join(home, '.cursor', 'mcp.json'), folder: home, maxBytes: MAX_CONFIG_FILE_BYTES },
      { file: 'vscode', path: join(appData, 'Code', 'User', 'mcp.json'), folder: appData, maxBytes: MAX_CONFIG_FILE_BYTES },
      { file: 'claude-desktop', path: join(appData, 'Claude', 'claude_desktop_config.json'), folder: appData, maxBytes: MAX_CONFIG_FILE_BYTES },
    ]
  }

  /** A host path as the person reads it: `~` for the home folder. */
  private displayPath(path: string): string {
    const home = this.home()
    return isInsideRoot(home, path) ? `~${path.slice(resolve(home).length).replaceAll('\\', '/')}` : path
  }

  private home(): string {
    return this.deps.home ?? homedir()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

/** The address that names a found server, as an integration's `url` would. */
function addressOf(entry: ConfigEntry): string {
  const transport = entry.transport
  if (!transport) return `invalid:${entry.place.path}\u0000${entry.place.scope}\u0000${entry.place.name}`
  return transport.kind === 'stdio' ? stdioServerAddress(transport) : transport.url
}

function mergeByAddress(entries: ConfigEntry[]): MergedEntry[] {
  const merged = new Map<string, MergedEntry>()
  for (const entry of entries) {
    const key = addressOf(entry)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { key, first: entry, places: [entry.place], transport: entry.transport && structuredClone(entry.transport), expands: entry.expands, valuesInFile: new Set(entry.valuesInFile), secrets: { env: new Map(entry.secrets.env), authorization: entry.secrets.authorization } })
      continue
    }
    mergeInto(existing, entry)
  }
  return [...merged.values()]
}

/** One more file's entry of the same address: its places, names, and values join the first. */
function mergeInto(existing: MergedEntry, entry: ConfigEntry): void {
  existing.places.push(entry.place)
  existing.expands ||= entry.expands
  for (const name of entry.valuesInFile) existing.valuesInFile.add(name)
  for (const [name, value] of entry.secrets.env) if (!existing.secrets.env.has(name)) existing.secrets.env.set(name, value)
  existing.secrets.authorization ??= entry.secrets.authorization
  // The same command in two files may name different variables: it needs every one.
  if (existing.transport?.kind === 'stdio' && entry.transport?.kind === 'stdio') addNew(existing.transport.envNames, entry.transport.envNames)
  if (existing.transport?.kind === 'http' && entry.transport?.kind === 'http') addNew(existing.transport.headerNames, entry.transport.headerNames)
}

function addNew(names: string[], more: string[]): void {
  for (const name of more) if (!names.includes(name)) names.push(name)
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

/**
 * Whether the host has the program a command names: a path, against its
 * folder, or a name on the login shell's PATH. It only looks; it never runs it.
 */
function findsProgram(command: string, cwd: string): boolean {
  if (command.includes('/') || command.includes('\\')) return isFile(isAbsolute(command) ? command : resolve(resolveHomePath(cwd), command))
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  return getCliPath().split(delimiter).some((folder) => folder && suffixes.some((suffix) => isFile(join(folder, command + suffix))))
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
