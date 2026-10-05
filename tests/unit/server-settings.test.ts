import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_HOST_CONFIG } from '@solus/contracts/host-config'
import { DEFAULT_EXECUTION_PREFERENCES } from '@solus/contracts/settings'

const originalDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string | undefined

afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  dataDir = undefined
  if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = originalDataDir
})

async function loadSettings(name: string, persisted?: object) {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-server-settings-'))
  process.env.SOLUS_DATA_DIR = dataDir
  if (persisted) writeFileSync(join(dataDir, 'server-settings.json'), JSON.stringify(persisted))
  return import(`../../packages/server/src/host/settings.ts?${name}`)
}

function savedHostConfig(): object {
  return JSON.parse(readFileSync(join(dataDir!, 'server-settings.json'), 'utf8')).hostConfig
}

describe.serial('server settings defaults', () => {
  test('allows remote connections for a new installation', async () => {
    const settings = await loadSettings('new-installation')
    expect(settings.getServerSettings().remoteAccess).toBe(true)
    expect(settings.getHostConfig().config).toEqual(DEFAULT_HOST_CONFIG)
  })

  test('preserves an explicit remote access opt-out', async () => {
    const settings = await loadSettings('remote-access-disabled', { remoteAccess: false })
    expect(settings.getServerSettings().remoteAccess).toBe(false)
  })

  test('defaults retention to 30 days and persists a replacement value', async () => {
    const settings = await loadSettings('metrics-retention')
    expect(settings.getServerSettings().metricsRetentionDays).toBe(30)

    settings.setMetricsRetentionDays(14)
    expect(settings.getServerSettings().metricsRetentionDays).toBe(14)
  })

  test('ignores the removed custom host-name setting', async () => {
    const settings = await loadSettings('removed-host-name', { name: 'Legacy override' })

    expect(settings.getServerSettings()).not.toHaveProperty('name')
  })
})

describe.serial('the stored host config heals one key at a time', () => {
  // The file is local to the host. A key this host does not know (a person's
  // key an older build stored) or a value that no longer validates must cost
  // only that key: the operator's other choices stay.
  test('unknown keys are dropped, a bad value falls back, and the valid keys are kept', async () => {
    const settings = await loadSettings('heal-per-key', {
      hostConfig: {
        archivedAutomationRetentionDays: 7,
        continueSessionsAfterHostRestart: 'sometimes',
        solusTools: 'all of them',
        analyticsEnabled: false,
        themeMode: 'dark',
        extraInstructions: 'A person wrote this.',
      },
    })
    const { config } = settings.getHostConfig()
    expect(config.archivedAutomationRetentionDays).toBe(7)
    expect(config.analyticsEnabled).toBe(false)
    expect(config.continueSessionsAfterHostRestart).toBe(DEFAULT_HOST_CONFIG.continueSessionsAfterHostRestart)
    expect(config.solusTools).toEqual(DEFAULT_HOST_CONFIG.solusTools)
    expect(Object.keys(config).sort()).toEqual(Object.keys(DEFAULT_HOST_CONFIG).sort())

    // The next write stores the healed config: the dropped keys do not come back.
    settings.setHostConfig({ archivedAutomationRetentionDays: 14 })
    expect(savedHostConfig()).not.toHaveProperty('themeMode')
    expect(savedHostConfig()).not.toHaveProperty('extraInstructions')
  })

  test('the pre-host-config top-level keys are not read', async () => {
    // A person's task lifecycle and writing models are theirs (plans/018); an
    // old top-level key does not make them the host's.
    const settings = await loadSettings('top-level-keys', {
      analytics: false,
      agentTaskLifecyclePolicy: 'autonomous',
      textGenerationModel: { provider: 'claude-code', model: 'claude-haiku-4-5-20251001' },
    })
    expect(settings.getHostConfig().config).toEqual(DEFAULT_HOST_CONFIG)
  })

  test('host config survives a restart', async () => {
    const first = await loadSettings('restart-write')
    first.setHostConfig({ archivedAutomationRetentionDays: 9, analyticsEnabled: false })
    const second = await import(`../../packages/server/src/host/settings.ts?restart-read`)
    expect(second.getHostConfig().config.archivedAutomationRetentionDays).toBe(9)
    expect(second.getHostConfig().config.analyticsEnabled).toBe(false)
  })
})

describe('writing done for a person', () => {
  test("uses the person's source-control writing choices, else the built-in ones", async () => {
    const settings = await loadSettings('source-control-writing')
    const mine = { mode: 'custom', customInstructions: 'Include a Risks section.', followPullRequestTemplate: false } as const
    expect(settings.sourceControlWritingFor({ sourceControlWriting: mine })).toEqual(mine)
    expect(settings.sourceControlWritingFor(undefined)).toEqual(DEFAULT_EXECUTION_PREFERENCES.sourceControlWriting)
  })
})
