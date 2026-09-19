import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'typesafe-credentials-'))
const previousDirectory = process.env.SOLUS_DATA_DIR
const previousKey = process.env.TYPESAFE_API_KEY
process.env.SOLUS_DATA_DIR = directory
delete process.env.TYPESAFE_API_KEY
const credentials = await import('@solus/server/typesafe/credentials')
const { getTypeSafe } = await import('@solus/server/typesafe/index')

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
  if (previousDirectory === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDirectory
  if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
  else process.env.TYPESAFE_API_KEY = previousKey
})

test('saved keys persist privately and rotation replaces the lazy client without making requests', () => {
  expect(() => getTypeSafe()).toThrow('Add a TypeSafe API key')
  credentials.setTypeSafeApiKey('first-synthetic-key')
  const path = join(directory, 'secrets', 'typesafe.json')
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ apiKey: 'first-synthetic-key' })
  expect(statSync(path).mode & 0o777).toBe(0o600)
  const first = getTypeSafe()
  expect(getTypeSafe()).toBe(first)
  credentials.setTypeSafeApiKey('second-synthetic-key')
  expect(getTypeSafe()).not.toBe(first)
  credentials.setTypeSafeApiKey(null)
  expect(() => getTypeSafe()).toThrow('Add a TypeSafe API key')
  process.env.TYPESAFE_API_KEY = 'environment-synthetic-key'
  expect(credentials.typeSafeKeyStatus()).toEqual({ source: 'environment' })
  expect(getTypeSafe()).not.toBe(first)
})
