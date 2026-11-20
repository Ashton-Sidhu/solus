// A small stdio MCP server that tests own (docs/plans/mcp-first-class.md §7.10).
// It speaks newline-delimited JSON-RPC on standard input and output.
//
//   --era modern|legacy   modern answers `server/discover`; legacy refuses it and needs `initialize`
//   --starts <file>       appends this process's PID to <file> once at each start
//   --stderr-env <name>   writes the value of <name> to standard error at start
//   --tools <a,b>         the tool names it lists (default echo,env,cwd,crash)
//
// Tools: `echo` answers its text, `env` the value of one variable (or "(unset)"),
// `cwd` the working directory, and `crash` ends the process without an answer.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}
const era = option('era') ?? 'modern'
const startsFile = option('starts')
if (startsFile) appendFileSync(startsFile, `${process.pid}\n`)
const stderrEnv = option('stderr-env')
if (stderrEnv) process.stderr.write(`starting with ${process.env[stderrEnv] ?? '(unset)'}\n`)
const toolNames = (option('tools') ?? 'echo,env,cwd,crash').split(',')

const tools = toolNames.map((name) => ({ name, description: `The ${name} tool.`, inputSchema: { type: 'object', properties: { text: { type: 'string' }, name: { type: 'string' } } } }))
const instructions = `Use the ${era} fake for tests.`

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

/** A modern result says it is complete; a legacy one has no `resultType`. */
function result(id, body) {
  send({ id, result: era === 'modern' ? { resultType: 'complete', ...body } : body })
}

/** A modern list is cacheable: it names how long and for whom. */
function listResult(id, body) {
  result(id, era === 'modern' ? { ttlMs: 60_000, cacheScope: 'private', ...body } : body)
}

function call(id, params) {
  const input = params?.arguments ?? {}
  const text = (value) => result(id, { content: [{ type: 'text', text: value }] })
  switch (params?.name) {
    case 'echo': return text(`echo: ${input.text ?? ''}`)
    case 'env': return text(process.env[input.name] ?? '(unset)')
    case 'cwd': return text(process.cwd())
    case 'crash': return process.exit(3)
    default: return send({ id, error: { code: -32602, message: `Unknown tool ${params?.name}` } })
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.id === undefined) return
  switch (message.method) {
    case 'server/discover':
      if (era !== 'modern') return send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
      return listResult(message.id, { supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, instructions, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fake-stdio', version: '1.0.0' } } })
    case 'initialize':
      return send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-stdio', version: '1.0.0' }, instructions } })
    case 'tools/list':
      return listResult(message.id, { tools })
    case 'tools/call':
      return call(message.id, message.params)
    case 'ping':
      return result(message.id, {})
    default:
      return send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
  }
})
// End-of-file on standard input: the host stopped or crashed, so this process stops by itself.
process.stdin.on('end', () => process.exit(0))
