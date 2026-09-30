import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, readdirSync } from 'fs'
import { isAbsolute } from 'path'

const replies: Array<string | Error> = []
const calls: string[][] = []
const environments: NodeJS.ProcessEnv[] = []
const directories: string[] = []
mock.module('child_process', () => ({
  execFile: (_file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }, callback: (error: Error | null, result: { stdout: string }) => void) => {
    calls.push(args)
    environments.push(options.env)
    expect(isAbsolute(options.cwd)).toBe(true)
    expect(options.cwd).not.toBe(process.cwd())
    expect(readdirSync(options.cwd)).toEqual([])
    directories.push(options.cwd)
    const reply = replies.shift()
    callback(reply instanceof Error ? reply : null, { stdout: typeof reply === 'string' ? reply : '' })
  },
}))
mock.module('@solus/server/cli-env', () => ({ getCliEnv: (extra?: NodeJS.ProcessEnv) => ({ ...extra }) }))
mock.module('@solus/server/analytics', () => ({ captureServerEvent: () => {} }))
mock.module('@solus/server/logger', () => ({ createLogger: () => ({ warn() {}, info() {}, error() {} }) }))
const { listInstalledSkills, removeSkill, installSkill } = await import('@solus/server/skills/skills-cli')
const installed = JSON.stringify([{ name: 'design', path: '/sandbox/skills/design', agents: ['Claude Code', 'Codex'], source: 'owner/skills' }])
beforeEach(() => { replies.length = 0; calls.length = 0; directories.length = 0; environments.length = 0 })
afterAll(() => mock.restore())

describe('a member\'s skills on a shared host', () => {
  const member = { claudeHome: '/seats/claude/alice', codexHome: '/seats/codex/alice' }

  test('install, list, and remove all act on the member\'s seats, never the host home', async () => {
    // WHY: a member's agent reads skills from their seat (CLAUDE_CONFIG_DIR and
    // CODEX_HOME); a skill in the host's ~/.claude is invisible to it and
    // reaches every other person on the host.
    replies.push('', installed, installed, '', '[]')
    expect((await installSkill('owner/skills@design', ['claude-code', 'codex'], member)).ok).toBe(true)
    expect(await listInstalledSkills(member)).toEqual({ ok: true, skills: JSON.parse(installed), scope: 'member' })
    expect((await removeSkill('design', member)).ok).toBe(true)
    for (const env of environments) {
      expect(env).toMatchObject({ CLAUDE_CONFIG_DIR: member.claudeHome, CODEX_HOME: member.codexHome, HOME: member.claudeHome })
    }
    // Plain files in each seat: a link would point at a store outside it.
    expect(calls[0]).toEqual(['-y', 'skills', 'add', 'owner/skills@design', '-g', '-y', '--copy', '-a', 'claude-code', '-a', 'codex'])
  })

  test('the host owner keeps the host\'s own homes', async () => {
    replies.push(installed)
    await listInstalledSkills()
    expect(environments[0].CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(environments[0].HOME).toBeUndefined()
  })
})

describe('global skill management', () => {
  test('all global commands use disposable directories and clean up after success or failure', async () => {
    replies.push(installed, '', installed, '', '[]', new Error('offline'))
    expect((await listInstalledSkills()).ok).toBe(true)
    expect((await installSkill('owner/skills@design', ['claude-code', 'codex'])).ok).toBe(true)
    expect(calls[1]).toEqual(['-y', 'skills', 'add', 'owner/skills@design', '-g', '-y', '-a', 'claude-code', '-a', 'codex'])
    expect((await removeSkill('design')).ok).toBe(true)
    expect((await listInstalledSkills()).ok).toBe(false)
    expect(directories).toHaveLength(6)
    expect(new Set(directories).size).toBe(6)
    for (const directory of directories) expect(existsSync(directory)).toBe(false)
  })
  test('lists the global scope and preserves provider and source information', async () => {
    replies.push(installed)
    expect(await listInstalledSkills()).toEqual({ ok: true, skills: JSON.parse(installed), scope: 'host' })
    expect(calls[0]).toEqual(['-y', 'skills', 'list', '-g', '--json'])
  })
  test('does not present a CLI failure or invalid inventory as an empty list', async () => {
    replies.push(new Error('offline'), 'not json')
    expect((await listInstalledSkills()).ok).toBe(false)
    expect((await listInstalledSkills()).ok).toBe(false)
  })
  test('rejects options, paths, and absent skills without removing anything', async () => {
    for (const name of ['--all', '../design', 'design/child', '..', '']) {
      expect((await removeSkill(name)).ok).toBe(false)
    }
    expect(calls).toHaveLength(0)
    replies.push('[]')
    expect((await removeSkill('missing')).ok).toBe(false)
    expect(calls).toHaveLength(1)
  })
  test('removes only the named global skill and checks that removal succeeded', async () => {
    replies.push(installed, '', '[]')
    expect(await removeSkill('design')).toEqual({ ok: true })
    expect(calls[1]).toEqual(['-y', 'skills', 'remove', 'design', '-g', '-y'])
  })
  test('reports partial removal even when the CLI exits successfully', async () => {
    replies.push(installed, '', installed)
    expect((await removeSkill('design')).ok).toBe(false)
  })
})
