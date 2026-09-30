import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const environment = ['SOLUS_DATA_DIR', 'SOLUS_API', 'SOLUS_DB', 'SOLUS_CLOUD_ISSUER', 'SOLUS_CLOUD_JWKS_URL', 'SOLUS_API_SIGNING_KEY'] as const
const previous = environment.map(key => [key, process.env[key]] as const)
let directory: string
let service: Awaited<ReturnType<typeof import('@solus/server/boot-solus-api').bootSolusApi>> | undefined
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'solus-api-service-'))
  Object.assign(process.env, { SOLUS_DATA_DIR: directory, SOLUS_API: '1', SOLUS_DB: process.env.SOLUS_DB ?? 'sqlite',
    SOLUS_CLOUD_ISSUER: 'https://issuer.example.test', SOLUS_CLOUD_JWKS_URL: 'https://issuer.example.test/jwks',
    SOLUS_API_SIGNING_KEY: Buffer.alloc(32, 13).toString('base64') })
  const { bootSolusApi } = await import('@solus/server/boot-solus-api')
  service = await bootSolusApi({ host: '127.0.0.1', port: 0 })
})
afterAll(async () => {
  await service?.shutdown()
  await resetTestDatabase()
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  rmSync(directory, { recursive: true, force: true })
})

test('the data service boots alone, serves HTTP, and exposes no execution or replaced CRUD handlers', async () => {
  expect(service).toBeDefined()
  const url = `http://127.0.0.1:${service!.port}`
  expect((await fetch(url + '/v1/openapi.json')).status).toBe(200)
  expect((await fetch(url + '/v1/tasks')).status).toBe(401)
  expect(service!.server.hasHandler('prompt')).toBe(false)
  expect(service!.server.hasHandler('automationRun')).toBe(false)
  expect(service!.server.hasHandler('tasksReadExtras')).toBe(true)
  expect(service!.server.hasHandler('sharedSessionPrompt')).toBe(true)
  expect(service!.server.hasHandler('workspaceProjectAdd')).toBe(true)
})

test('cloud onboarding lists repositories through the Solus API with the account GitHub', () => {
  // WHY: the web client lists the repositories it can add from its workspace service,
  // which holds no GitHub of its own and reads the caller's account connection. Without
  // this handler the onboarding project stage answers "Unknown method".
  expect(service!.server.hasHandler('providerRepositories')).toBe(true)
})
