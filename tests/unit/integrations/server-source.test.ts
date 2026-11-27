import { describe, expect, test } from 'bun:test'
import { readServerSource, urlSourceAdd } from '@solus/contracts/integrations/server-source'

/**
 * The one field of Add server (docs/integrations.md): a person pastes what a
 * server's setup page gives them, and Solus fills the form from it, so they
 * do not copy each part into its own field.
 */
describe('reading the one field of Add server', () => {
  test('an https address is a URL, and anything else is a command line', () => {
    expect(readServerSource('  https://mcp.linear.app/mcp ')).toEqual({ kind: 'url', url: 'https://mcp.linear.app/mcp', headers: [] })
    expect(readServerSource('npx -y @acme/mcp')).toEqual({ kind: 'command', line: 'npx -y @acme/mcp', env: [] })
    expect(readServerSource('   ')).toEqual({ kind: 'empty' })
  })

  test('an address half typed is not yet a command', () => {
    // WHY: the field labels what it reads as and shows the command form for a
    // command. While a person types `https://`, it must not show "Command",
    // the mono font, and the command's fields, then take them away at `//`.
    for (const partial of ['h', 'HTTP', 'https', 'https:', 'https:/', 'http:/']) expect(readServerSource(partial)).toEqual({ kind: 'empty' })
    expect(readServerSource('http-server --port 3000')).toMatchObject({ kind: 'command' })
    expect(readServerSource('https://')).toMatchObject({ kind: 'url' })
  })

  test('a Claude Code entry keeps its static OAuth client and its plain headers', () => {
    // WHY: a server that does not register Solus by itself needs the client the
    // setup page gave; without it the sign-in stops and asks for it again.
    const source = readServerSource(JSON.stringify({ mcpServers: { acme: { type: 'http', url: 'https://mcp.acme.dev/mcp', oauth: { clientId: 'acme-client', callbackPort: 8080 }, headers: { 'X-Team': 'labs', 'X-Key': '${ACME_KEY}' } } } }))
    expect(source).toEqual({ kind: 'url', name: 'acme', url: 'https://mcp.acme.dev/mcp', clientId: 'acme-client', headers: [{ name: 'X-Team', value: 'labs' }, { name: 'X-Key' }] })
  })

  test('a command entry becomes one line the host starts, with its variables', () => {
    const source = readServerSource(`"memory": { "command": "npx", "args": ["-y", "@acme/mcp server"], "env": { "API_KEY": "s3cret", "REGION": 2, "TOKEN": "\${env:TOKEN}" }, "cwd": "~/work" },`)
    expect(source).toEqual({ kind: 'command', name: 'memory', line: "npx -y '@acme/mcp server'", cwd: '~/work', env: [{ name: 'API_KEY', value: 's3cret' }, { name: 'REGION', value: '2' }, { name: 'TOKEN' }] })
  })

  test('VS Code tables, a bare entry, and a table by name all read', () => {
    expect(readServerSource(JSON.stringify({ servers: { gh: { type: 'http', url: 'https://api.githubcopilot.com/mcp' } } }))).toMatchObject({ kind: 'url', name: 'gh' })
    expect(readServerSource(JSON.stringify({ url: 'https://x.example/mcp' }))).toMatchObject({ kind: 'url', url: 'https://x.example/mcp' })
    expect(readServerSource(JSON.stringify({ local: { command: 'uvx', args: ['tool'] } }))).toMatchObject({ kind: 'command', name: 'local', line: 'uvx tool' })
  })

  test('JSON that is not one usable server says why, and fills nothing', () => {
    expect(readServerSource('{ "mcpServers": ')).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('not valid JSON') })
    expect(readServerSource(JSON.stringify({ mcpServers: { a: { url: 'https://a.example' }, b: { command: 'b' } } }))).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('2 servers') })
    expect(readServerSource(JSON.stringify({ mcpServers: { a: { url: 'ftp://a.example' } } }))).toMatchObject({ kind: 'invalid' })
    expect(readServerSource(JSON.stringify({ theme: 'dark' }))).toMatchObject({ kind: 'invalid' })
  })
})

describe('what the connect card sends for an address', () => {
  test('a static client goes with Automatic, and named headers make a headers server with the plain values', () => {
    expect(urlSourceAdd({ kind: 'url', url: 'https://a.example/mcp', headers: [], clientId: 'static' })).toEqual({ auth: { kind: 'automatic', client: { clientId: 'static' } }, values: [] })
    expect(urlSourceAdd({ kind: 'url', url: 'https://a.example/mcp', headers: [{ name: 'X-Key', value: 'v' }, { name: 'X-Team' }] }))
      .toEqual({ auth: { kind: 'headers', names: ['X-Key', 'X-Team'] }, values: [{ name: 'X-Key', value: 'v' }] })
    expect(urlSourceAdd({ kind: 'url', url: 'https://a.example/mcp', headers: [] })).toEqual({ values: [] })
  })
})
