import { describe, expect, test } from 'bun:test'
import type { FoundServer } from '@solus/contracts/integration-types'
import type { FoundPortPlace } from '@solus/contracts/integrations/local-servers'
import { FoundServerLabels } from '@solus/contracts/integrations/found-server-labels'

// docs/plans/mcp-first-class.md §8.6, §9.2: desktop, web, and mobile say the same
// words about one found server, and name the host whose loopback a server runs on.

const port: FoundPortPlace = { kind: 'port', runningServerId: 'r1', endpointId: 'e1', port: 7201, processName: 'node', checkout: 'main', serverInfo: { name: 'weather', title: 'Weather', version: '2.1.0' } }

function server(overrides: Partial<FoundServer> = {}): FoundServer {
  return {
    foundId: 'f1',
    fingerprint: 'p1',
    name: 'tool',
    foundIn: [{ kind: 'file', file: 'cursor', scope: 'user', path: '~/.cursor/mcp.json', name: 'tool' }],
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

  test('a command offers the file values only when the file gives a value for each name', () => {
    // WHY (§8.3): a command started with part of its values fails; the values form then asks for all.
    expect(new FoundServerLabels(server({ valuesInFile: ['API_KEY'] }), 'studio').fileValues).toBe('Use the values of API_KEY in the file')
    expect(new FoundServerLabels(server({ valuesInFile: ['OTHER'] }), 'studio').fileValues).toBeNull()
    expect(new FoundServerLabels(server({ transport: { kind: 'http', url: 'https://x.example/mcp', headerNames: ['Authorization'] }, valuesInFile: ['Authorization'] }), 'studio').fileValues)
      .toBe('Use the Authorization header in the file as your key')
  })
})
