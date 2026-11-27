import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeAutoModeRestriction, claudeAutoFallsBack } from '../../packages/server/src/execution/agents/claude/claude-auto-mode'

let root: string
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

test('reads the working folder and selected Claude home with the launch setting sources', async () => {
  root = await mkdtemp(join(tmpdir(), 'solus-claude-auto-'))
  const cwd = join(root, 'checkout')
  const home = join(root, 'claude')
  await mkdir(join(cwd, '.claude'), { recursive: true })
  await mkdir(home)
  const read = (args: string[] = []) => claudeAutoModeRestriction(cwd, home, args, ['user', 'project'], async () => ({}))

  await writeFile(join(cwd, '.claude', 'settings.local.json'), '{"disableAutoMode":"disable"}')
  expect(await read()).toBeNull()
  expect(await read(['--setting-sources=project,local'])).toBe('project-settings')
  await writeFile(join(cwd, '.claude', 'settings.json'), '{"permissions":{"disableAutoMode":"disable"}}')
  expect(await read()).toBe('project-settings')
  await writeFile(join(home, 'settings.json'), '{"disableAutoMode":"disable"}')
  expect(await read()).toBe('user-settings')
  await writeFile(join(home, 'remote-settings.json'), '{"disableAutoMode":"disable"}')
  expect(await read()).toBe('managed-settings')
})

test('shows a fallback only when the requested Auto starts in the asking mode', () => {
  expect(claudeAutoFallsBack('auto', [], 'default')).toBe(true)
  expect(claudeAutoFallsBack('auto', [], 'auto')).toBe(false)
  expect(claudeAutoFallsBack('auto', [], undefined)).toBe(false)
  expect(claudeAutoFallsBack('auto', ['--permission-mode=default'], 'default')).toBe(false)
  expect(claudeAutoFallsBack('supervised', [], 'default')).toBe(false)
})

test('reads a launch override and skips a project settings link outside the member folder', async () => {
  root = await mkdtemp(join(tmpdir(), 'solus-claude-auto-'))
  const cwd = join(root, 'checkout')
  const home = join(root, 'claude')
  await mkdir(join(cwd, '.claude'), { recursive: true })
  await mkdir(home)
  const outside = join(root, 'outside.json')
  await writeFile(outside, '{"disableAutoMode":"disable"}')
  await symlink(outside, join(cwd, '.claude', 'settings.json'))
  const read = (args: string[]) => claudeAutoModeRestriction(cwd, home, args, ['project'], async () => ({}), cwd)
  expect(await read([])).toBeNull()
  expect(await read(['--settings', '{"disableAutoMode":"disable"}'])).toBe('user-settings')
})
