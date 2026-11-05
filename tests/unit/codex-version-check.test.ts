import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAppServerClient, codexVersionProblem, MIN_CODEX_VERSION } from '@solus/server/execution/agents/codex/codex-agent'

// t3code #27281: an old Codex fails later with a raw protocol error
// ("Invalid payload for method 'thread/start'"), which names no cause. Solus
// reads the version from `initialize` and says what to update instead.
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A stand-in app-server that answers `initialize` with `answer` and every other request with {}. */
function fakeCodex(answer: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'solus-codex-version-'))
  dirs.push(dir)
  const file = join(dir, 'codex')
  writeFileSync(file, `#!/usr/bin/env bun
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const message = JSON.parse(buffer.slice(0, index))
    buffer = buffer.slice(index + 1)
    const reply = message.method === 'initialize' ? ${answer} : { result: {} }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply }) + '\\n')
  }
})
`)
  chmodSync(file, 0o755)
  return file
}

describe('Codex version check', () => {
  test('an old Codex is refused with the version to update to', () => {
    expect(codexVersionProblem('Solus/0.144.3 (Mac OS 15.5.0; arm64) iTerm.app')).toBe(
      `Codex 0.144.3 does not work with this Solus. Update Codex to ${MIN_CODEX_VERSION} or later, then try again.`,
    )
  })

  test('the minimum and newer Codex versions pass, and so does a user agent with no version', () => {
    expect(codexVersionProblem(`Solus/${MIN_CODEX_VERSION} (Linux; x86_64)`)).toBeNull()
    expect(codexVersionProblem('Solus/0.166.0 (Mac OS 26.5; arm64)')).toBeNull()
    expect(codexVersionProblem('Solus/1.0.0')).toBeNull()
    expect(codexVersionProblem('codex app-server')).toBeNull()
    expect(codexVersionProblem(undefined)).toBeNull()
  })

  test('a request to an old Codex fails with the actionable error, not a later protocol error', async () => {
    const client = new CodexAppServerClient({ binaryPath: fakeCodex(`{ result: { userAgent: 'Solus/0.144.3 (Linux; x86_64)' } }`) })
    await expect(client.request('thread/list', {})).rejects.toThrow('Codex 0.144.3 does not work with this Solus')
    // The refused process is not kept: an updated Codex starts on the next request.
    expect(client.hasStarted).toBe(false)
    client.shutdown()
  })

  test('a Codex that refuses initialize says to update it', async () => {
    const client = new CodexAppServerClient({ binaryPath: fakeCodex(`{ error: { code: -32602, message: 'Invalid request: unknown field' } }`) })
    await expect(client.request('thread/list', {})).rejects.toThrow(`Update Codex to ${MIN_CODEX_VERSION} or later`)
    client.shutdown()
  })

  test('a current Codex starts and answers requests', async () => {
    const client = new CodexAppServerClient({ binaryPath: fakeCodex(`{ result: { userAgent: 'Solus/0.166.0 (Linux; x86_64)' } }`) })
    expect(await client.request('thread/list', {})).toEqual({})
    client.shutdown()
  })
})
