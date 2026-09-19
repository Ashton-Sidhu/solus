import { expect, mock, test } from 'bun:test'

// The login probe is a whole CLI process starting up. Count synchronous spawns
// at the module boundary: one here is one main-thread stall per status read.
const childProcess = await import('node:child_process')
const realExecFileSync = childProcess.execFileSync
const realSpawnSync = childProcess.spawnSync
let syncSpawns = 0
const countedChildProcess = () => ({
  ...childProcess,
  execFileSync: (...args: Parameters<typeof realExecFileSync>) => { syncSpawns += 1; return realExecFileSync(...args) },
  spawnSync: (...args: Parameters<typeof realSpawnSync>) => { syncSpawns += 1; return realSpawnSync(...args) },
})
mock.module('child_process', countedChildProcess)
mock.module('node:child_process', countedChildProcess)

const { providerLoginConnected } = await import('@solus/server/seats/seat-login')

test('the host login probe never spawns synchronously', async () => {
  // WHY: `claude auth status` took ~200 ms of main thread on every usage read
  // and every seat status, and the first transcript page waited behind it.
  syncSpawns = 0
  const answer = providerLoginConnected('claude-code', null)
  expect(answer).toBeInstanceOf(Promise)
  expect(typeof await answer).toBe('boolean')
  expect(syncSpawns).toBe(0)
})

test('an injected probe decides the answer', async () => {
  const probed: string[] = []
  const connected = await providerLoginConnected('claude-code', '/seats/claude/bob', async (command, args, env) => {
    probed.push(`${command} ${args.join(' ')} ${env.CLAUDE_CONFIG_DIR}`)
    return true
  })
  expect(connected).toBe(true)
  expect(probed).toEqual(['claude auth status /seats/claude/bob'])
})
