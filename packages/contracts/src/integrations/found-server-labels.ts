import type { ConfigFileKind, FoundPlace, FoundServer, FoundUnsupportedReason, IntegrationFoundChange } from '../integration-types'
import { commandLineText } from './command-server'
import type { FoundPortPlace } from './local-servers'

/**
 * The words for a found server (docs/plans/mcp-first-class.md §8.6), one set
 * for the host, desktop and web, and mobile, so each surface says the same
 * thing about the same server.
 */

const FILE_LABELS = {
  'mcp-json': 'Project .mcp.json',
  'claude-json': 'Claude Code',
  'codex-config': 'Codex',
  cursor: 'Cursor',
  vscode: 'VS Code',
  'claude-desktop': 'Claude Desktop',
} satisfies Record<ConfigFileKind, string>

/** The tool that keeps a config file. */
export function configFileLabel(file: ConfigFileKind): string {
  return FILE_LABELS[file]
}

/** Why a found server cannot be added, as one sentence. */
export function foundUnsupportedText(reason: FoundUnsupportedReason): string {
  switch (reason) {
    case 'sse': return 'It uses the HTTP+SSE transport, which MCP deprecated.'
    case 'expansion': return 'It uses ${…}, and Solus expands nothing. Write the value itself in the file, or add the server by hand.'
    case 'not-allowed': return 'Only an administrator of this host can add a command.'
    case 'invalid': return 'Solus cannot read this entry as an MCP server.'
  }
}

/** The order of a server's source logos: the files of the agents that Solus runs first, then the other tools' files, then a port of the host. */
const SOURCE_ORDER: Array<ConfigFileKind | 'port'> = ['claude-json', 'codex-config', 'mcp-json', 'cursor', 'vscode', 'claude-desktop', 'port']

/**
 * Which agent of Solus loads the servers of a file: Claude Code and Codex load
 * their own files, and no agent loads another tool's file. Solus starts Claude
 * Code without the `local` setting source, so a project entry of
 * `~/.claude.json` (the default of `claude mcp add`) loads only outside Solus.
 */
function fileLoader(place: FoundPlace): string {
  switch (place.file) {
    case 'claude-json': return place.scope === 'project' ? 'Claude loads it outside Solus only' : 'Claude loads it'
    case 'mcp-json': return 'Claude loads it'
    case 'codex-config': return 'Codex loads it'
    default: return 'No agent loads it'
  }
}

/**
 * One place a found server is in, as a logo on its row (§8.6): whose file it
 * is, or `port`, and the words of its hover and screen-reader label, "Claude
 * Code · ~/.claude.json · Claude loads it".
 */
export interface FoundSource {
  kind: ConfigFileKind | 'port'
  label: string
  /** The file turns the server off, so its tool does not load it: the logo is dimmed. */
  isTurnedOff: boolean
}

/**
 * The words of one found server on one host: what the row, the add dialog,
 * and the phone's alert say. The host's name is part of the place of a server
 * on its loopback, so each client names the host it shows (§9.2).
 */
export class FoundServerLabels {
  constructor(private readonly server: FoundServer, private readonly hostLabel: string) {}

  /** What the row shows under the name: the command line, as an installed command reads, or the URL. */
  get target(): string {
    const transport = this.server.transport
    if (!transport) return ''
    return transport.kind === 'stdio' ? commandLineText(transport) : transport.url
  }

  /**
   * Where the server is, as one line: its files, "Claude Code (~/.claude.json),
   * Cursor (.cursor/mcp.json)", and the port it answered on (§9.2).
   */
  get places(): string {
    return this.server.foundIn.map((place) => place.kind === 'port' ? portPlaceText(place, this.hostLabel) : `${configFileLabel(place.file)} (${place.path})`).join(', ')
  }

  /** The port place, when the server runs on the host's loopback. */
  get port(): FoundPortPlace | null {
    return this.server.foundIn.find((place): place is FoundPortPlace => place.kind === 'port') ?? null
  }

  /**
   * What a running local server said about itself, and that Solus did not
   * check it (§9.2): any program on the host can answer on a port, so the
   * person reads the port and the process before they add it. Null for a
   * server of the files only.
   */
  get portIdentity(): string | null {
    const port = this.port
    if (!port) return null
    const info = port.serverInfo
    const said = info ? `It says it is ${info.title ?? info.name}${info.version ? ` ${info.version}` : ''}.` : 'It answered as an MCP server but did not say its name.'
    return `${said} Solus did not verify this: any program on this host can answer on a port.`
  }

  /** Where the server was found, one logo for each file or port, in the source order. */
  get sources(): FoundSource[] {
    const rank = (place: FoundServer['foundIn'][number]) => SOURCE_ORDER.indexOf(place.kind === 'port' ? 'port' : place.file)
    return [...this.server.foundIn].sort((a, b) => rank(a) - rank(b)).map((place) => place.kind === 'port'
      ? { kind: 'port', label: portPlaceText(place, this.hostLabel), isTurnedOff: false }
      : { kind: place.file, label: [configFileLabel(place.file), place.path, place.turnedOff ? 'turned off' : fileLoader(place)].join(' · '), isTurnedOff: place.turnedOff === true })
  }

  /** The host has no program for the command: the add dialog says so before the person adds it. */
  get missingProgram(): string | null {
    const transport = this.server.transport
    return this.server.commandMissing && transport?.kind === 'stdio' ? `This host does not have the program ${transport.command}. Install it before you start the server.` : null
  }

  /** The state in a few words, for the row's trailing text or its screen-reader label. */
  get state(): string {
    switch (this.server.state) {
      case 'new': return 'Not added'
      case 'added': return 'Added'
      case 'changed': return 'Changed in the file'
      case 'unsupported': return this.server.unsupported === 'not-allowed' ? 'Administrators only' : 'Not supported'
    }
  }

  /** Why the server cannot be added, or null when it can. */
  get unsupported(): string | null {
    return this.server.state === 'unsupported' && this.server.unsupported ? foundUnsupportedText(this.server.unsupported) : null
  }

  /** What an add does with the file's plain values, or null when it has none to copy. */
  get fileValues(): string | null {
    const { transport, valuesInFile } = this.server
    if (!transport || valuesInFile.length === 0) return null
    if (transport.kind === 'http') return 'Use the Authorization header in the file as your key'
    if (transport.kind !== 'stdio') return null
    // A command takes the file's values only when the file gives one for each name (§8.3).
    if (!transport.envNames.every((name) => valuesInFile.includes(name))) return null
    return `Use the values of ${transport.envNames.join(', ')} in the file`
  }
}

/** A running local server's place: "Port 8000 on studio · node · main". The port and the process are the host's. */
function portPlaceText(place: FoundPortPlace, hostLabel: string): string {
  return [`Port ${place.port} on ${hostLabel}`, place.processName, place.checkout].filter(Boolean).join(' · ')
}

/** The short state of an installed server on the host's loopback that does not run now (§9.3). Neutral, never an error. */
export const NOT_RUNNING_LABEL = 'Not running'

/** Why an installed server on the host's loopback shows no tools now (§9.3). */
export function notRunningText(name: string, hostLabel: string): string {
  return `${name} is not running on ${hostLabel}. Start it, and its tools show here.`
}

/** The label of an installed server that joins only one project's runs (§8.4), on every client's row. */
export function projectOnlyLabel(projectName: string): string {
  return `Only in ${projectName}`
}

/** The warning on a server that only a repository's files hold (§8.6). */
export function projectCommandWarning(projectName: string): string {
  return `This command comes from a file in the repository ${projectName}. Read it before you add it.`
}

/** One change the person may make to a found server in one of its files (§8.8). */
export interface FoundFileAction {
  place: FoundPlace
  change: IntegrationFoundChange
  /** "Turn off in Codex", "Delete from Claude Code". */
  label: string
}

/** The tool whose behavior a change of the file changes: Claude Code reads the project's `.mcp.json`. */
function placeTool(place: FoundPlace): string {
  return place.file === 'mcp-json' ? 'Claude Code' : configFileLabel(place.file)
}

/**
 * The changes the caller may make to a server in its files, one place after
 * another: turn it off or on for the tool, then delete it there. The host
 * says what each file allows (`canTurnOff`, `canDelete`).
 */
export function foundFileActions(server: FoundServer): FoundFileAction[] {
  const actions: FoundFileAction[] = []
  for (const place of server.foundIn) {
    if (place.kind !== 'file' || !place.canTurnOff) continue
    const change = place.turnedOff ? 'turn-on' : 'turn-off'
    actions.push({ place, change, label: `${change === 'turn-on' ? 'Turn on' : 'Turn off'} in ${placeTool(place)}` })
  }
  for (const place of server.foundIn) {
    if (place.kind !== 'file' || !place.canDelete) continue
    actions.push({ place, change: 'delete', label: `Delete from ${place.file === 'mcp-json' ? '.mcp.json' : configFileLabel(place.file)}` })
  }
  return actions
}

/** The question before a delete: what is removed, and who stops loading it. */
export function foundDeleteQuestion(name: string, place: FoundPlace): string {
  return `Delete ${name} from ${place.path}? ${placeTool(place)} no longer loads it.`
}

/** The line under the found list: why a server one agent loads is still worth an add (§8.6). */
export const FOUND_FOOTER_TEXT = 'Each agent loads only the servers in its own config file. Add a server to give it to Claude and Codex.'

/** The empty state of the view (§8.6, §9.2). */
export const NO_FOUND_SERVERS_TEXT = 'No MCP servers were found in the config files of this host or running on it.'

/** The empty state when every server on the host is already in Solus: they are on the Installed list. */
export const ALL_FOUND_ADDED_TEXT = 'Every MCP server on this host is in Solus. You find them under Installed.'

/** Why the view shows no running local server (§9.1): the host could not list its listeners. */
export function portScanUnavailableText(reason: string): string {
  return `Solus cannot look for MCP servers that run on this host. ${reason}`
}
