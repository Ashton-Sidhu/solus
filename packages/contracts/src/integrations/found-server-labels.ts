import type { ConfigFileKind, FoundServer, FoundTransport, FoundUnsupportedReason } from '../integration-types'

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

/** A command as one line, each argument quoted when it holds a space, so the person reads exactly what will run. */
export function commandLineText(transport: Extract<FoundTransport, { kind: 'stdio' }>): string {
  return [transport.command, ...transport.args].map(quoted).join(' ')
}

function quoted(part: string): string {
  return part === '' || /[\s"'\\]/.test(part) ? `'${part.replaceAll("'", "'\\''")}'` : part
}

/** What the row shows under the name: the command line, or the URL. */
export function foundTargetText(server: Pick<FoundServer, 'transport'>): string {
  const transport = server.transport
  if (!transport) return ''
  return transport.kind === 'stdio' ? commandLineText(transport) : transport.url
}

/** The files a found server is in, as one line: "Claude Code (~/.claude.json), Cursor (.cursor/mcp.json)". */
export function foundPlacesText(server: Pick<FoundServer, 'foundIn'>): string {
  return server.foundIn.map((place) => `${configFileLabel(place.file)} (${place.path})`).join(', ')
}

/** The state of a found server in a few words, for the row's trailing text or its screen-reader label. */
export function foundStateText(server: Pick<FoundServer, 'state' | 'unsupported'>): string {
  switch (server.state) {
    case 'new': return 'Not added'
    case 'added': return 'Added'
    case 'changed': return 'Changed in the file'
    case 'unsupported': return server.unsupported === 'not-allowed' ? 'Administrators only' : 'Not supported'
  }
}

/** The label of an installed server that joins only one project's runs (§8.4), on every client's row. */
export function projectOnlyLabel(projectName: string): string {
  return `Only in ${projectName}`
}

/** The warning on a server that only a repository's files hold (§8.6). */
export function projectCommandWarning(projectName: string): string {
  return `This command comes from a file in the repository ${projectName}. Read it before you add it.`
}

/** What an add does with the file's plain values, or null when it has none to copy. */
export function fileValuesText(server: Pick<FoundServer, 'transport' | 'valuesInFile'>): string | null {
  const transport = server.transport
  if (!transport || server.valuesInFile.length === 0) return null
  if (transport.kind === 'http') return 'Use the Authorization header in the file as your key'
  if (transport.kind !== 'stdio') return null
  // A command takes the file's values only when the file gives one for each name (§8.3).
  if (!transport.envNames.every((name) => server.valuesInFile.includes(name))) return null
  return `Use the values of ${transport.envNames.join(', ')} in the file`
}

/** The empty state of the view (§8.6). */
export const NO_FOUND_SERVERS_TEXT = 'No MCP servers were found in the config files of this host.'
