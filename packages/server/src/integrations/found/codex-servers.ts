import { join } from 'node:path'
import { z } from 'zod'
import type { FoundPlace } from '@solus/contracts/integration-types'
import { invalidEntry, stdioEntry, urlEntry, type ConfigEntry, type NamedValue } from './config-entry'

/**
 * The Codex config files (docs/plans/mcp-first-class.md §8.1),
 * `~/.codex/config.toml` and `<project>/.codex/config.toml`, read through the
 * Codex app-server (`config/read` with its layers). So Solus parses no TOML,
 * and a project layer that Codex turns off, such as one of a project Codex
 * does not trust, adds nothing. A server is a `[mcp_servers.<name>]` table:
 * `command` for a command, `url` for Streamable HTTP. Codex has no `sse`.
 */

const MAX_SERVERS_PER_LAYER = 200

const valueSchema = z.union([z.string(), z.number().transform(String)])

/** One `mcp_servers.<name>` entry of the Codex config: the one schema of the found list and the CLI skip. */
export const codexMcpServerSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), valueSchema).optional(),
  // Variables Codex forwards from its own environment: a name with no value in the file.
  env_vars: z.array(z.union([z.string(), z.object({ name: z.string() }).transform((item) => item.name)])).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  http_headers: z.record(z.string(), valueSchema).optional(),
  env_http_headers: z.record(z.string(), z.string()).optional(),
  bearer_token_env_var: z.string().optional(),
  // A server the person turned off. Codex does not load it, so the CLI skip leaves it alone.
  enabled: z.boolean().optional(),
})
type CodexEntry = z.infer<typeof codexMcpServerSchema>

/** One layer of `config/read`, as far as Solus reads it. An entry that does not parse is null. */
const codexLayerSchema = z.object({
  name: z.union([
    z.object({ type: z.literal('user'), file: z.string().min(1) }),
    z.object({ type: z.literal('project'), dotCodexFolder: z.string().min(1) }),
    z.object({ type: z.string() }),
  ]),
  config: z.object({
    mcp_servers: z.record(z.string(), codexMcpServerSchema.nullable().catch(null)).optional().catch(undefined),
  }).catch({ mcp_servers: undefined }),
  disabledReason: z.string().nullable().optional(),
})

/** The servers of the user and project layers that Codex has on; `displayPath` gives a file as the person reads it. */
export function codexServers(layers: unknown[], displayPath: (path: string) => string): Array<{ scope: 'user' | 'project'; path: string; entries: ConfigEntry[] }> {
  const read: Array<{ scope: 'user' | 'project'; path: string; entries: ConfigEntry[] }> = []
  for (const raw of layers) {
    const layer = codexLayerSchema.safeParse(raw)
    if (!layer.success || layer.data.disabledReason) continue
    const name = layer.data.name
    const where = 'file' in name ? { scope: 'user' as const, file: name.file } : 'dotCodexFolder' in name ? { scope: 'project' as const, file: join(name.dotCodexFolder, 'config.toml') } : null
    if (!where) continue
    const path = displayPath(where.file)
    const servers = Object.entries(layer.data.config.mcp_servers ?? {}).slice(0, MAX_SERVERS_PER_LAYER)
    read.push({
      scope: where.scope,
      path,
      entries: servers.map(([serverName, entry]) => {
        const place: FoundPlace = { kind: 'file', file: 'codex-config', scope: where.scope, path, name: serverName }
        return entry ? codexEntry(place, entry) : invalidEntry(place)
      }),
    })
  }
  return read
}

function codexEntry(place: FoundPlace, entry: CodexEntry): ConfigEntry {
  if (entry.command !== undefined) {
    const env: NamedValue[] = Object.entries(entry.env ?? {})
    const names = new Set(env.map(([name]) => name))
    for (const name of entry.env_vars ?? []) if (!names.has(name)) env.push([name, undefined])
    return stdioEntry(place, { command: entry.command, args: entry.args ?? [], env, cwd: entry.cwd })
  }
  if (entry.url !== undefined) {
    const headers: NamedValue[] = Object.entries(entry.http_headers ?? {})
    // A header from a variable: its name is known, its value is not in the file.
    for (const name of Object.keys(entry.env_http_headers ?? {})) headers.push([name, undefined])
    if (entry.bearer_token_env_var !== undefined) headers.push(['Authorization', undefined])
    return urlEntry(place, 'http', { url: entry.url, headers: dedupeHeaders(headers) })
  }
  return invalidEntry(place)
}

/** One header for each name, whatever its case; the first wins, as a fixed value comes first. */
function dedupeHeaders(headers: NamedValue[]): NamedValue[] {
  const seen = new Set<string>()
  return headers.filter(([name]) => {
    const key = name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
