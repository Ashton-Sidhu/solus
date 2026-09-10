import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'

let directory: string
let cliPath: Promise<string>
let onPathLookup = () => {}
const queries: Options[] = []
const realCliEnv = await import('@solus/server/cli-env')
mock.module('@solus/server/cli-env', () => ({
  ...realCliEnv,
  warmCliPath: () => {
    onPathLookup()
    return cliPath
  },
}))
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Options }) => {
    queries.push(options)
    return Object.assign((async function* () {
      yield { type: 'result', subtype: 'success', result: 'done' }
    })(), {
      supportedCommands: async () => [],
      rewindFiles: async () => {},
    })
  },
}))
const { ClaudeAgent } = await import('@solus/server/agents/claude/claude-agent')

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'solus-claude-executable-'))
  cliPath = Promise.resolve(directory)
  onPathLookup = () => {}
  queries.length = 0
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function installClaude(): string {
  const executable = join(directory, 'claude')
  writeFileSync(executable, '#!/bin/sh\nexit 0\n')
  chmodSync(executable, 0o755)
  return executable
}

describe('installed Claude executable', () => {
  test('the first turn waits for PATH discovery and passes an explicit executable', async () => {
    const executable = installClaude()
    let finishLookup!: (path: string) => void
    cliPath = new Promise((resolve) => { finishLookup = resolve })
    const started = new Promise<void>((resolve) => { onPathLookup = resolve })
    const run = new ClaudeAgent().run({ prompt: 'hello', cwd: directory })
    const drain = (async () => { for await (const _ of run.events) { /* drain */ } })()
    await started
    expect(queries).toHaveLength(0)
    finishLookup(directory)
    await drain
    await run.result
    expect(queries).toHaveLength(1)
    expect(queries[0].pathToClaudeCodeExecutable).toBe(executable)
  })

  test('a missing CLI fails with setup guidance before the SDK can use its fallback', async () => {
    const run = new ClaudeAgent().run({ prompt: 'hello', cwd: directory })
    const result = run.result.catch((error: Error) => error)
    for await (const _ of run.events) { /* drain */ }
    expect(await result).toMatchObject({ message: expect.stringContaining('Install it through Solus setup') })
    expect(queries).toHaveLength(0)
  })

  test('installation and removal after boot are visible to the same agent', async () => {
    const agent = new ClaudeAgent()
    await expect(agent.supportedCommands({ cwd: directory })).rejects.toThrow('Claude Code was not found')
    const executable = installClaude()
    await expect(agent.supportedCommands({ cwd: directory })).resolves.toEqual([])
    expect(queries[0].pathToClaudeCodeExecutable).toBe(executable)
    rmSync(executable)
    await expect(agent.supportedCommands({ cwd: directory })).rejects.toThrow('Claude Code was not found')
    expect(queries).toHaveLength(1)
  })

  test('usage and rewind also require the installed CLI', async () => {
    const agent = new ClaudeAgent()
    await expect(agent.readUsageReport()).rejects.toThrow('Claude Code was not found')
    await expect(agent.rewindFiles('session', 'checkpoint', directory)).rejects.toThrow('Claude Code was not found')
    expect(queries).toHaveLength(0)
    const executable = installClaude()
    await agent.readUsageReport()
    await agent.rewindFiles('session', 'checkpoint', directory)
    expect(queries).toHaveLength(2)
    expect(queries.map((options) => options.pathToClaudeCodeExecutable)).toEqual([executable, executable])
  })

  test('cancellation during PATH discovery does not start a CLI process', async () => {
    installClaude()
    let finishLookup!: (path: string) => void
    cliPath = new Promise((resolve) => { finishLookup = resolve })
    const started = new Promise<void>((resolve) => { onPathLookup = resolve })
    const abortController = new AbortController()
    const run = new ClaudeAgent().run({ prompt: 'hello', cwd: directory, abortController })
    const drain = (async () => { for await (const _ of run.events) { /* drain */ } })()
    await started
    abortController.abort()
    finishLookup(directory)
    await drain
    await expect(run.result).resolves.toMatchObject({ signal: 'SIGINT' })
    expect(queries).toHaveLength(0)
  })
})
