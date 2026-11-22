import { describe, expect, test } from 'bun:test'
import type { FoundPlace, FoundServer } from '@solus/contracts/integration-types'
import type { FoundPortPlace } from '@solus/contracts/integrations/local-servers'
import { FoundServerLabels, foundDeleteQuestion, foundFileActions } from '@solus/contracts/integrations/found-server-labels'

// docs/plans/mcp-first-class.md §8.6, §9.2: desktop, web, and mobile say the same
// words about one found server, and name the host whose loopback a server runs on.

const port: FoundPortPlace = { kind: 'port', runningServerId: 'r1', endpointId: 'e1', port: 7201, processName: 'node', checkout: 'main', serverInfo: { name: 'weather', title: 'Weather', version: '2.1.0' } }

function server(overrides: Partial<FoundServer> = {}): FoundServer {
  return {
    foundId: 'f1',
    fingerprint: 'p1',
    name: 'tool',
    foundIn: [{ kind: 'file', file: 'cursor', scope: 'user', path: '~/.cursor/mcp.json', filePath: '/home/me/.cursor/mcp.json', name: 'tool' }],
    transport: { kind: 'stdio', command: 'npx', args: ['-y', 'tool'], envNames: ['API_KEY'] },
    state: 'new',
    projectOnly: false,
    valuesInFile: [],
    ...overrides,
  }
}

describe('the words of a found server', () => {
  test('a server on the loopback names the host it runs on', () => {
    // WHY: the phone said "this host" where desktop and web named the host. Each
    // client now gives the host's name, and there is no default to fall back to.
    const labels = new FoundServerLabels(server({ foundIn: [server().foundIn[0]!, port], transport: { kind: 'http', url: 'http://127.0.0.1:7201/mcp', headerNames: [] } }), 'studio')
    expect(labels.places).toBe('Cursor (~/.cursor/mcp.json), Port 7201 on studio · node · main')
    expect(labels.port).toEqual(port)
    expect(labels.target).toBe('http://127.0.0.1:7201/mcp')
    expect(labels.portIdentity).toBe('It says it is Weather 2.1.0. Solus did not verify this: any program on this host can answer on a port.')
  })

  test('a server of the files only has no port and no identity note', () => {
    const labels = new FoundServerLabels(server(), 'studio')
    expect(labels.target).toBe('npx -y tool')
    expect(labels.places).toBe('Cursor (~/.cursor/mcp.json)')
    expect(labels.port).toBeNull()
    expect(labels.portIdentity).toBeNull()
  })

  test('the state, and why a server cannot be added', () => {
    expect(new FoundServerLabels(server({ state: 'changed' }), 'studio').state).toBe('Changed in the file')
    const refused = new FoundServerLabels(server({ state: 'unsupported', unsupported: 'not-allowed' }), 'studio')
    expect(refused.state).toBe('Administrators only')
    expect(refused.unsupported).toBe('Only an administrator of this host can add a command.')
    expect(new FoundServerLabels(server(), 'studio').unsupported).toBeNull()
  })

  test('a row shows the logo of each tool whose file has the server, and which agent loads it', () => {
    // WHY: Claude Code and Codex load the servers of their own files by themselves. A row with
    // only "Add" read as "not installed", though Claude runs used the server.
    const place = (file: 'claude-json' | 'codex-config' | 'cursor', turnedOff?: boolean) => ({ kind: 'file' as const, file, scope: 'user' as const, path: `~/${file}`, filePath: `/home/me/${file}`, name: 'tool', ...(turnedOff && { turnedOff }) })
    const sources = (foundIn: FoundServer['foundIn']) => new FoundServerLabels(server({ foundIn }), 'studio').sources
    // The agents' own files first, whatever order the host read them in.
    expect(sources([place('cursor'), place('codex-config'), place('claude-json')])).toEqual([
      { kind: 'claude-json', label: 'Claude Code · ~/claude-json · Claude loads it', isTurnedOff: false },
      { kind: 'codex-config', label: 'Codex · ~/codex-config · Codex loads it', isTurnedOff: false },
      { kind: 'cursor', label: 'Cursor · ~/cursor · No agent loads it', isTurnedOff: false },
    ])
    // Codex does not load a server its file turns off.
    expect(sources([place('codex-config', true)])).toEqual([{ kind: 'codex-config', label: 'Codex · ~/codex-config · turned off', isTurnedOff: true }])
    // Solus starts Claude Code without the `local` source, so a project entry of ~/.claude.json loads only outside Solus.
    expect(sources([{ ...place('claude-json'), scope: 'project' }])[0]!.label).toBe('Claude Code · ~/claude-json · Claude loads it outside Solus only')
    expect(sources([port])).toEqual([{ kind: 'port', label: 'Port 7201 on studio · node · main', isTurnedOff: false }])
  })

  test('the file actions follow what the host allows, turns before deletes, with the same words on every client', () => {
    // WHY (§8.8): the host decides what a caller may change; a client offers that and nothing more.
    const place = (file: 'claude-json' | 'codex-config' | 'mcp-json', flags: Partial<FoundPlace>) => ({ kind: 'file' as const, file, scope: 'user' as const, path: `~/${file}`, filePath: `/home/me/${file}`, name: 'tool', ...flags })
    const actions = foundFileActions(server({ foundIn: [
      place('claude-json', { canTurnOff: true, canDelete: true }),
      place('codex-config', { canTurnOff: true, turnedOff: true, canDelete: false }),
      place('mcp-json', { canTurnOff: false, canDelete: true }),
    ] }))
    expect(actions.map((action) => action.label)).toEqual(['Turn off in Claude Code', 'Turn on in Codex', 'Delete from Claude Code', 'Delete from .mcp.json'])
    // A member's list carries no flags, so no client offers a change.
    expect(foundFileActions(server())).toEqual([])
    expect(foundDeleteQuestion('paper', place('claude-json', {}))).toBe('Delete paper from ~/claude-json? Claude Code no longer loads it.')
  })

  test('the add dialog warns when the host has no program for the command', () => {
    expect(new FoundServerLabels(server({ commandMissing: true }), 'studio').missingProgram).toBe('This host does not have the program npx. Install it before you start the server.')
    expect(new FoundServerLabels(server(), 'studio').missingProgram).toBeNull()
  })

  test('a command offers the file values only when the file gives a value for each name', () => {
    // WHY (§8.3): a command started with part of its values fails; the values form then asks for all.
    expect(new FoundServerLabels(server({ valuesInFile: ['API_KEY'] }), 'studio').fileValues).toBe('Use the values of API_KEY in the file')
    expect(new FoundServerLabels(server({ valuesInFile: ['OTHER'] }), 'studio').fileValues).toBeNull()
    expect(new FoundServerLabels(server({ transport: { kind: 'http', url: 'https://x.example/mcp', headerNames: ['Authorization'] }, valuesInFile: ['Authorization'] }), 'studio').fileValues)
      .toBe('Use the Authorization header in the file as your key')
  })
})
