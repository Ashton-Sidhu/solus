import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_HOST_CONFIG } from '@solus/contracts/host-config'
import { adoptProvisionedLink, applyHostCategory, resetHostCategoryForTests } from '@solus/server/host/host-category'

const previousDataDir = process.env.SOLUS_DATA_DIR
let directory: string
let settings: typeof import('@solus/server/host/settings')
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'solus-restart-settings-'))
  process.env.SOLUS_DATA_DIR = directory
  settings = await import('@solus/server/host/settings')
})
afterEach(() => resetHostCategoryForTests())
afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

test('personal and self-hosted hosts default to continuation and can opt out', () => {
  expect(DEFAULT_HOST_CONFIG.continueSessionsAfterHostRestart).toBe(true)
  expect(settings.getHostConfig().config.continueSessionsAfterHostRestart).toBe(true)
  applyHostCategory('self-hosted')
  expect(settings.getHostConfig().config.continueSessionsAfterHostRestart).toBe(true)
  expect(settings.setHostConfig({ continueSessionsAfterHostRestart: false }).config.continueSessionsAfterHostRestart).toBe(false)
  settings.setHostConfig({ continueSessionsAfterHostRestart: true })
})

test('a provisioned cloud host disables continuation even with a saved opt-in', () => {
  settings.setHostConfig({ continueSessionsAfterHostRestart: true })
  adoptProvisionedLink({ organizationId: 'organization' })
  expect(settings.getHostConfig().config.continueSessionsAfterHostRestart).toBe(false)
  expect(settings.setHostConfig({ continueSessionsAfterHostRestart: true }).config.continueSessionsAfterHostRestart).toBe(false)
})
