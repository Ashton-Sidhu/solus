import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const INSTALL_SCRIPT = join(import.meta.dir, '../../scripts/install.sh')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** An existing install with a launcher that records the arguments it was given. */
function installedHost() {
  const root = mkdtempSync(join(tmpdir(), 'solus-install-test-'))
  dirs.push(root)
  const runtimeDir = join(root, 'runtime')
  const binDir = join(root, 'bin')
  const argsFile = join(root, 'launcher-args')
  mkdirSync(join(runtimeDir, 'current'), { recursive: true })
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'solus'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\n`)
  chmodSync(join(binDir, 'solus'), 0o755)
  return { runtimeDir, binDir, argsFile }
}

function runInstall(host: ReturnType<typeof installedHost>, args: string[]) {
  const result = Bun.spawnSync(['sh', INSTALL_SCRIPT, ...args], {
    env: { ...process.env, SOLUS_RUNTIME_DIR: host.runtimeDir, SOLUS_BIN_DIR: host.binDir },
  })
  return { exitCode: result.exitCode, stderr: result.stderr.toString() }
}

// WHY: the onboarding one-liner carries a link code. A user who already has
// Solus must still get the host linked, not a "use solus update" dead end.
test('a link code on an existing install runs setup with that code', () => {
  const host = installedHost()
  const result = runInstall(host, ['--link', 'TICKET-1', '--cloud-url', 'https://cloud.example'])
  expect(result.exitCode).toBe(0)
  expect(readFileSync(host.argsFile, 'utf8').trim().split('\n'))
    .toEqual(['setup', '--link', 'TICKET-1', '--cloud-url', 'https://cloud.example'])
})

test('a plain second install still refuses and points at solus update', () => {
  const result = runInstall(installedHost(), [])
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain('Use solus update')
})

test('a link flag without a code fails before anything runs', () => {
  const host = installedHost()
  const result = runInstall(host, ['--link'])
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain('--link requires a code')
})

test('an unknown flag fails instead of being ignored', () => {
  const result = runInstall(installedHost(), ['--lnk', 'TICKET-1'])
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain('Unknown option: --lnk')
})
