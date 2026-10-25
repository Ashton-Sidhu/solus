import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod'
import { FileSecretStore } from '@solus/server/platform/secrets'

const schema = z.object({ token: z.string() })
const originalDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-secrets-test-'))
  process.env.SOLUS_DATA_DIR = dataDir
})

afterEach(() => {
  process.env.SOLUS_DATA_DIR = originalDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

test('a new secrets folder is given to this user once, and a secret reads back', () => {
  // WHY: Windows ignores file modes, and a data folder outside the user profile
  // inherits write access for every user. The folder's access is set when it
  // is made, so a secret costs no process start of its own.
  const restricted: string[] = []
  const store = new FileSecretStore((dir) => restricted.push(dir))
  store.saveJson('github', '', { token: 'a' })
  store.saveJson('codex', '', { token: 'b' })
  expect(restricted).toEqual([join(dataDir, 'secrets')])
  expect(store.loadJson('github', '', schema)).toEqual({ token: 'a' })
})

test.skipIf(process.platform === 'win32')('POSIX keeps the folder and each file to this user with modes', () => {
  const store = new FileSecretStore(null)
  store.saveJson('github', '', { token: 'a' })
  expect(statSync(join(dataDir, 'secrets')).mode & 0o777).toBe(0o700)
  expect(statSync(join(dataDir, 'secrets', 'github.json')).mode & 0o777).toBe(0o600)
})
