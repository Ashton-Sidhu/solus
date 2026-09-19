import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, readdirSync } from 'fs'
import { isAbsolute } from 'path'

const replies: Array<string | Error> = []
const calls: string[][] = []
const directories: string[] = []
mock.module('child_process', () => ({
  execFile: (_file: string, args: string[], options: { cwd: string }, callback: (error: Error | null, result: { stdout: string }) => void) => {
    calls.push(args)
    expect(isAbsolute(options.cwd)).toBe(true)
    expect(options.cwd).not.toBe(process.cwd())
    expect(readdirSync(options.cwd)).toEqual([])
    directories.push(options.cwd)
    const reply = replies.shift()
    callback(reply instanceof Error ? reply : null, { stdout: typeof reply === 'string' ? reply : '' })
  },
}))
mock.module('@solus/server/cli-env', () => ({ getCliEnv: () => ({}) }))
mock.module('@solus/server/analytics', () => ({ captureServerEvent: () => {} }))
mock.module('@solus/server/logger', () => ({ createLogger: () => ({ warn() {}, info() {}, error() {} }) }))
const { listInstalledSkills, removeSkill, installSkill } = await import('@solus/server/skills/skills-cli')
const installed = JSON.stringify([{ name: 'design', path: '/sandbox/skills/design', agents: ['Claude Code', 'Codex'], source: 'owner/skills' }])
beforeEach(() => { replies.length = 0; calls.length = 0; directories.length = 0 })
afterAll(() => mock.restore())

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
    expect(await listInstalledSkills()).toEqual({ ok: true, skills: JSON.parse(installed) })
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
