import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { descendantGroups, endTreeAfterExit } from '@solus/server/platform/process-tree'
import { claudeLaunch } from '@solus/server/execution/agents/claude/claude-agent'

// Every PID here is one this test started; cleanup signals only those.
const started: number[] = []

afterEach(() => {
  for (const pid of started.splice(0)) {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function groupOf(pid: number): number {
  return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
}

async function gone(pid: number): Promise<boolean> {
  // A killed orphan is reaped by init, not by this test, so wait for it within a bound.
  for (let i = 0; i < 100 && isAlive(pid); i++) await Bun.sleep(20)
  return !isAlive(pid)
}

/** An agent CLI stand-in: one child in its group, and one that leads its own group, as a shell command does. */
async function agentWithChildren(): Promise<{ agent: ChildProcess; inGroup: number; ownGroup: number }> {
  const agent = spawn('/bin/sh', ['-c', 'sleep 60 & echo $!; set -m; sleep 60 & echo $!; wait'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  started.push(agent.pid!)
  const lines = createInterface({ input: agent.stdout! })[Symbol.asyncIterator]()
  const inGroup = Number((await lines.next()).value)
  const ownGroup = Number((await lines.next()).value)
  started.push(inGroup, ownGroup)
  return { agent, inGroup, ownGroup }
}

describe.skipIf(process.platform === 'win32')('an agent process tree', () => {
  test('a Stop ends the agent’s children, also one in a group of its own, once the agent exits', async () => {
    // WHY: a dev server or Chrome an agent started must not outlive the turn the user stopped.
    const { agent, inGroup, ownGroup } = await agentWithChildren()
    expect(groupOf(inGroup)).toBe(agent.pid!)
    expect(groupOf(ownGroup)).toBe(ownGroup)

    endTreeAfterExit(agent, 100)
    agent.kill('SIGKILL')
    await once(agent, 'exit')

    expect(await gone(inGroup)).toBe(true)
    expect(await gone(ownGroup)).toBe(true)
  })

  test('unless Solus ends the tree, what the agent leaves outlives it', async () => {
    // WHY: the CLI does not end its children when it exits, so Solus must end them itself.
    const { agent, inGroup, ownGroup } = await agentWithChildren()
    agent.kill('SIGKILL')
    await once(agent, 'exit')
    expect(isAlive(inGroup)).toBe(true)
    expect(isAlive(ownGroup)).toBe(true)
  })

  test('a turn that ends by itself ends what its CLI left running', async () => {
    // WHY: a dev server or Chrome an agent started must not outlive its turn, also one the user did not stop.
    // The CLI stand-in exits when the SDK closes its stdin, as the Claude CLI does at the end of a turn.
    const spawnCli = claudeLaunch(undefined, new AbortController().signal).spawnClaudeCodeProcess!
    const cli = spawnCli({
      command: '/bin/sh',
      args: ['-c', 'sleep 60 & echo $!; set -m; sleep 60 & echo $!; set +m; cat >/dev/null'],
      cwd: tmpdir(),
      env: { PATH: process.env.PATH },
      signal: new AbortController().signal,
    }) as ChildProcess
    started.push(cli.pid!)
    const lines = createInterface({ input: cli.stdout! })[Symbol.asyncIterator]()
    const inGroup = Number((await lines.next()).value)
    const ownGroup = Number((await lines.next()).value)
    started.push(inGroup, ownGroup)

    cli.stdin!.end()
    await once(cli, 'exit')

    expect(await gone(inGroup)).toBe(true)
    expect(await gone(ownGroup)).toBe(true)
  })

  test('the server’s own process group is never one to signal', () => {
    // WHY: a child that did not get a group of its own shares the server's; signalling that would stop Solus.
    const child = spawn('sleep', ['60'], { stdio: 'ignore' })
    started.push(child.pid!)
    expect(groupOf(child.pid!)).toBe(groupOf(process.pid))
    expect(descendantGroups(child.pid!).has(groupOf(process.pid))).toBe(false)
  })
})
