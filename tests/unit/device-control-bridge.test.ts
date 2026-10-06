import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { DeviceAgentBridge, agentSessionName, isReadCommand, type DeviceAgentBinding } from '@solus/server/devices/device-agent-bridge'
import { DeviceControl } from '@solus/server/devices/device-control'

/**
 * The guarded agent bridge (plan 016, S01): an agent's CLI never holds the
 * daemon credential, its commands run in its own binding, and a mutating
 * command is refused once a person has taken control.
 */

interface Received {
  path: string
  authorization: string | undefined
  body: { method?: string; params?: { token?: string; session?: string; command?: string } }
}

let daemon: Server | null = null
let bridge: DeviceAgentBridge | null = null

afterEach(async () => {
  await bridge?.stop()
  await new Promise<void>((resolve) => (daemon ? daemon.close(() => resolve()) : resolve()))
  daemon = null
  bridge = null
})

async function setup() {
  const received: Received[] = []
  daemon = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      received.push({ path: req.url ?? '', authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : {} })
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }))
    })
  })
  await new Promise<void>((resolve) => daemon!.listen(0, '127.0.0.1', () => resolve()))
  const address = daemon.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const control = new DeviceControl(() => {})
  bridge = new DeviceAgentBridge({
    endpoint: () => ({ baseUrl: `http://127.0.0.1:${port}`, token: 'daemon-secret' }),
    acquire: (binding, holder) => { control.acquireForAgent(binding, holder) },
  })
  const url = await bridge.start()
  const binding: DeviceAgentBinding = { sessionId: 's1', deviceHostId: 'local', deviceId: 'SIM-1', platform: 'ios', agentSession: agentSessionName('s1', 'local', 'SIM-1'), label: 'Claude agent' }
  const token = bridge.bind(binding)
  const call = (command: string, init: { token?: string; flags?: { udid?: string } } = {}) => fetch(`${url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${init.token ?? token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent_device.command', params: { session: 'other-session', command, positionals: [], flags: init.flags ?? {} } }),
  }).then(async (response) => ({ status: response.status, body: await response.json() as { error?: { message: string } } }))
  return { received, control, binding, call, token }
}

describe('device agent bridge', () => {
  test('the daemon credential replaces the bridge token and the session is pinned', async () => {
    const { received, call, binding } = await setup()
    const reply = await call('click')
    expect(reply.body.error).toBeUndefined()
    expect(received[0]!.authorization).toBe('Bearer daemon-secret')
    expect(received[0]!.body.params?.token).toBe('daemon-secret')
    expect(received[0]!.body.params?.session).toBe(binding.agentSession)
  })

  test('an unknown or revoked token reaches nothing', async () => {
    const { received, call } = await setup()
    expect((await call('click', { token: 'guess' })).status).toBe(401)
    bridge!.revoke(() => true)
    expect((await call('snapshot')).status).toBe(401)
    expect(received).toHaveLength(0)
  })

  test('a command aimed at another device is refused', async () => {
    const { received, call } = await setup()
    const reply = await call('click', { flags: { udid: 'SIM-2' } })
    expect(reply.body.error?.message).toContain('device_open')
    expect(received).toHaveLength(0)
  })

  test('after a person takes control, agent mutations stop and reads continue', async () => {
    // WHY: Take control must stop agent input through Solus, not only label it.
    const { received, call, control, binding } = await setup()
    await call('click')
    control.acquireForUser(binding, { kind: 'user', clientId: 'client-a', label: 'Alice' })
    const refused = await call('fill')
    expect(refused.body.error?.message).toContain('took control')
    const read = await call('snapshot')
    expect(read.body.error).toBeUndefined()
    expect(received.map((entry) => entry.body.params?.command)).toEqual(['click', 'snapshot'])
    control.resumeAgent(binding)
    expect((await call('click')).body.error).toBeUndefined()
  })

  test('two agents cannot drive one device', async () => {
    const { call, control, binding } = await setup()
    control.acquireForAgent(binding, { kind: 'agent', sessionId: 'other', label: 'Codex agent' })
    const reply = await call('click')
    expect(reply.body.error?.message).toContain('Codex agent is controlling')
  })

  test('unknown commands are treated as mutations', () => {
    expect(isReadCommand('snapshot')).toBe(true)
    expect(isReadCommand('install')).toBe(false)
    expect(isReadCommand('some-future-command')).toBe(false)
  })
})
