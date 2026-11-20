import { z } from 'zod'
import type { ConfigFileKind, FoundPlace } from '@solus/contracts/integration-types'
import { invalidEntry, stdioEntry, urlEntry, type ConfigEntry } from './config-entry'

/**
 * The JSON config files (docs/plans/mcp-first-class.md §8.1): a project
 * `.mcp.json`, Claude Code's `~/.claude.json`, Cursor's and VS Code's
 * `mcp.json`, and Claude Desktop's config. Each holds a table of servers by
 * name, `mcpServers`, or `servers` in VS Code's own format. Keys Solus does not
 * know are ignored. An entry Solus cannot read is kept as an invalid entry, so
 * the person sees it and why, and the other entries of the file still read.
 */

/** More servers than this in one table are not read: a config file is untrusted input. */
const MAX_SERVERS_PER_TABLE = 200
const MAX_NAME_LENGTH = 200

/** Claude Code reads an entry with a URL and no `type` as an error and skips it; Cursor and Claude Desktop read it as HTTP. */
const TYPE_NEEDED_FOR_URL = new Set<ConfigFileKind>(['mcp-json', 'claude-json'])

/** A value of `env` or `headers`: the tools write a string; a number reads as its text. */
const valueSchema = z.union([z.string(), z.number().transform(String)])

const jsonEntrySchema = z.object({
  type: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), valueSchema).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), valueSchema).optional(),
})
type JsonEntry = z.infer<typeof jsonEntrySchema>

/** A table of servers by name; an entry that does not parse is null. */
const serverTableSchema = z.record(z.string(), jsonEntrySchema.nullable().catch(null)).optional().catch(undefined)
type ServerTable = z.infer<typeof serverTableSchema>

const jsonConfigSchema = z.object({
  mcpServers: serverTableSchema,
  servers: serverTableSchema,
  // `~/.claude.json` keeps the servers of each project under the project's path.
  projects: z.record(z.string(), z.object({ mcpServers: serverTableSchema }).catch({ mcpServers: undefined })).optional().catch(undefined),
})
export type JsonConfig = z.infer<typeof jsonConfigSchema>

/** The parsed file, or why it is not one. Parsing runs no code: `JSON.parse` and a schema only. */
export function parseJsonConfig(text: string): { ok: true; config: JsonConfig } | { ok: false; problem: string } {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, problem: 'It is not valid JSON.' }
  }
  const parsed = jsonConfigSchema.safeParse(value)
  return parsed.success ? { ok: true, config: parsed.data } : { ok: false, problem: 'It is not a JSON object.' }
}

/** A file's own table of servers. */
export function serverTableOf(config: JsonConfig, file: ConfigFileKind): ServerTable {
  return file === 'vscode' ? config.servers : config.mcpServers
}

/** Every entry of one table of servers. */
export function jsonServers(table: ServerTable, place: Omit<FoundPlace, 'name'>): ConfigEntry[] {
  return Object.entries(table ?? {})
    .slice(0, MAX_SERVERS_PER_TABLE)
    .filter(([name]) => name.trim().length > 0 && name.length <= MAX_NAME_LENGTH)
    .map(([name, entry]) => (entry ? jsonEntry({ ...place, name }, entry) : invalidEntry({ ...place, name })))
}

function jsonEntry(place: FoundPlace, entry: JsonEntry): ConfigEntry {
  const { type, url, command } = entry
  if (type === 'sse') return url === undefined ? invalidEntry(place) : urlEntry(place, 'sse', { url, headers: [] })
  if (command !== undefined && (type === 'stdio' || type === undefined)) {
    return stdioEntry(place, { command, args: entry.args ?? [], env: Object.entries(entry.env ?? {}), cwd: entry.cwd })
  }
  if (url !== undefined && (type === 'http' || type === 'streamable-http' || (type === undefined && !TYPE_NEEDED_FOR_URL.has(place.file)))) {
    return urlEntry(place, 'http', { url, headers: Object.entries(entry.headers ?? {}) })
  }
  return invalidEntry(place)
}
