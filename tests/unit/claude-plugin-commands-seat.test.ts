import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TurnSeat } from '@solus/server/execution/seats/seat-manager'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let ClaudeBackend: typeof import('@solus/server/execution/agents/claude/claude-backend')['ClaudeBackend']
beforeAll(async () => {
  ;({ ClaudeBackend } = await import('@solus/server/execution/agents/claude/claude-backend'))
})

// The `/` menu on a shared host: each person sees the skills in the folder their own
// agent reads, never the host's. A member who is their own Linux user reads the
// `.claude` in their home; the host login reads the host's.

const roots: string[] = []
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
})

function skill(configDir: string, name: string): void {
  mkdirSync(join(configDir, 'skills', name), { recursive: true })
  writeFileSync(join(configDir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`)
}

describe('ClaudeBackend.listPluginCommands', () => {
  test('a member and the host login on one host get their own global skills', async () => {
    const root = mkdtempSync(join(tmpdir(), 'solus-plugin-commands-'))
    roots.push(root)
    const hostConfig = join(root, 'host', '.claude')
    const memberHome = join(root, 'members', 'ada')
    const project = join(root, 'project')
    skill(hostConfig, 'host-only')
    skill(join(memberHome, '.claude'), 'grill-me')
    mkdirSync(project)
    process.env.CLAUDE_CONFIG_DIR = hostConfig

    const member: TurnSeat = {
      seat: { kind: 'user', userId: { kind: 'account', accountId: 'ada' } },
      provider: 'claude-code',
      home: join(root, 'seats', 'claude', 'ada'),
      launch: { env: { HOME: memberHome }, user: { uid: 20000 } },
    }
    const backend = new ClaudeBackend()
    const names = (result: { global: Array<{ name: string }> }) => result.global.map((command) => command.name)

    // The host first: its cached list must not answer the member's request.
    expect(names(await backend.listPluginCommands(project))).toEqual(['host-only'])
    expect(names(await backend.listPluginCommands(project, undefined, member))).toEqual(['grill-me'])
    expect(names(await backend.listPluginCommands(project))).toEqual(['host-only'])
  })
})
