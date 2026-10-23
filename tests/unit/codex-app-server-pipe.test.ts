import { expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'

let child: (EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; killed: boolean; kill(): void }) | undefined
mock.module('child_process', () => ({
  spawn() {
    child = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(_chunk, _encoding, callback) { callback(new Error('write EPIPE')) } }),
      stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
      kill() { this.killed = true },
    })
    queueMicrotask(() => child?.emit('spawn'))
    return child
  },
}))
mock.module('@solus/server/cli-env', () => ({
  findOnPath: () => '/fixture/codex', warmCliPath: async () => '/fixture', hostCliEnv: () => ({ PATH: '/fixture' }),
  launchedProcess: (launch: { env: NodeJS.ProcessEnv }, file: string, args: string[]) => ({ file, args, env: launch.env }),
}))
mock.module('@solus/server/execution/agents/plugins', () => ({ solusPluginsDir: () => '/fixture/plugins' }))
mock.module('@solus/server/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }))
const { CodexAppServerClient } = await import('@solus/server/execution/agents/codex/codex-agent')

test('a provider that closes stdin fails the request without crashing the desktop', async () => {
  const client = new CodexAppServerClient()
  try {
    await expect(client.request('model/list')).rejects.toThrow('not running')
    expect(child?.stdin.listenerCount('error')).toBe(1)
  } finally {
    client.shutdown()
  }
})
