import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_HOST_CONFIG } from '@solus/contracts/host-config'
import { adoptRegistration, resetMachineKindForTests } from '@solus/server/host/machine-kind'

const previousDataDir = process.env.SOLUS_DATA_DIR
let directory: string
let settings: typeof import('@solus/server/host/settings')
/** The gate the restart recovery reads before it continues any session. */
let restartRecoveryEnabled: typeof import('@solus/server/execution/sessions/restart-continuation')['restartRecoveryEnabled']
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'solus-restart-settings-'))
  process.env.SOLUS_DATA_DIR = directory
  settings = await import('@solus/server/host/settings')
  ;({ restartRecoveryEnabled } = await import('@solus/server/execution/sessions/restart-continuation'))
})
afterEach(() => resetMachineKindForTests())
afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

test('a personal machine defaults to continuation and can opt out, also when it is registered to an account', () => {
  expect(DEFAULT_HOST_CONFIG.continueSessionsAfterHostRestart).toBe(true)
  expect(settings.getHostConfig().config.continueSessionsAfterHostRestart).toBe(true)
  // A registration that names no organization: a person's desktop, or their own standalone server.
  adoptRegistration({})
  expect(settings.getHostConfig().config.continueSessionsAfterHostRestart).toBe(true)
  expect(restartRecoveryEnabled()).toBe(true)
  expect(settings.setHostConfig({ continueSessionsAfterHostRestart: false }).config.continueSessionsAfterHostRestart).toBe(false)
  expect(restartRecoveryEnabled()).toBe(false)
  settings.setHostConfig({ continueSessionsAfterHostRestart: true })
})

// WHY (plans/034 §2): the kind decides this, not who operates the compute. A cloud
// machine has no owner to continue work for, whether Solus or an operator runs it.
test.each([
  ['whose compute Solus operates', { organizationId: 'organization', hasManagedCompute: true }],
  ['that its operator runs', { organizationId: 'organization' }],
])('a cloud machine %s disables continuation even with a saved opt-in', (_name, registration) => {
  settings.setHostConfig({ continueSessionsAfterHostRestart: true })
  adoptRegistration(registration)
  expect(restartRecoveryEnabled()).toBe(false)
  expect(settings.getHostConfig().config.continueSessionsAfterHostRestart).toBe(false)
  expect(settings.setHostConfig({ continueSessionsAfterHostRestart: true }).config.continueSessionsAfterHostRestart).toBe(false)
  // The saved choice is not kept for later: the machine never becomes personal again.
  resetMachineKindForTests()
  expect(settings.getHostConfig().config.continueSessionsAfterHostRestart).toBe(false)
  settings.setHostConfig({ continueSessionsAfterHostRestart: true })
})
