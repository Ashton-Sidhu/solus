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
    expect(settings.getServerSettings().remoteAccess).toBe('any')
    expect(settings.getHostConfig().config).toEqual(DEFAULT_HOST_CONFIG)
  })

  test('preserves an explicit remote access opt-out', async () => {
    const settings = await loadSettings('remote-access-disabled', { remoteAccess: false })
    expect(settings.getServerSettings().remoteAccess).toBe('off')
  })

  test('migrates old enabled settings and keeps private mode after a write', async () => {
    const settings = await loadSettings('remote-access-enabled', { remoteAccess: true })
    expect(settings.getServerSettings().remoteAccess).toBe('any')
    settings.setRemoteAccess('private')
    expect(JSON.parse(readFileSync(join(dataDir!, 'server-settings.json'), 'utf8')).remoteAccess).toBe('private')
  })

  test('a stored file without the old switch stays on loopback', async () => {
    const settings = await loadSettings('remote-access-absent', { metricsRetentionDays: 10 })
    expect(settings.getServerSettings().remoteAccess).toBe('off')
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
  test('removes retired tool preferences without enabling other disabled tools', async () => {
    const settings = await loadSettings('retired-jev', {
      hostConfig: { solusTools: { read_automation_run: false, ask_jev: false, read_task_sessions: false, search_external_doc: false, read_external_doc: false, read_external_doc_comments: false, write_external_doc_comment: false, create_external_doc: false, update_external_doc: false, import_external_doc: false, read_work: false } },
    })
    expect(settings.getHostConfig().config.solusTools).toEqual({ read_work: false })
    settings.setHostConfig({ analyticsEnabled: false })
    expect(savedHostConfig()).toHaveProperty('solusTools', { read_work: false })
  })

  // A person who turned find_works off meant the tool, not its old name.
  test('a switch saved under a renamed tool applies to its new name', async () => {
    const settings = await loadSettings('renamed-find-works', {
      hostConfig: { solusTools: { find_works: false, read_work: false } },
    })
    expect(settings.getHostConfig().config.solusTools).toEqual({ list_works: false, read_work: false })
    settings.setHostConfig({ analyticsEnabled: false })
    expect(savedHostConfig()).toHaveProperty('solusTools', { list_works: false, read_work: false })
  })

  // WHY: a tool that was turned off must stay off when it becomes one action
  // of a grouped tool. Turning the whole group off is the safe reading.
  test('a switch on a tool that was grouped moves to its new tool, and off wins', async () => {
    const settings = await loadSettings('grouped-tools', {
      hostConfig: { solusTools: { delete_webhook: false, create_webhook: true, list_automations: true, read_work: false } },
    })
    expect(settings.getHostConfig().config.solusTools).toEqual({ manage_webhooks: false, read_automations: true, read_work: false })
  })

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

  // WHY: the own ingress address names who is proxied (plans/035 §0.8). A stored value
  // that is not an https origin must give none, not a broken address, and cost no other key.
  test('a stored public address that is not https falls back to none; an https one is read as its origin', async () => {
    const bad = await loadSettings('public-address-bad', { hostConfig: { publicAddress: 'ftp://solus.example.com', archivedAutomationRetentionDays: 21 } })
    expect(bad.getHostConfig().config.publicAddress).toBe('')
    expect(bad.getHostConfig().config.archivedAutomationRetentionDays).toBe(21)
    const good = await loadSettings('public-address-good', { hostConfig: { publicAddress: 'https://solus.example.com' } })
    expect(good.getHostConfig().config.publicAddress).toBe('https://solus.example.com')
  })

  test('host config survives a restart', async () => {
    const first = await loadSettings('restart-write')
    first.setHostConfig({ archivedAutomationRetentionDays: 9, analyticsEnabled: false })
    const second = await import(`../../packages/server/src/host/settings.ts?restart-read`)
    expect(second.getHostConfig().config.archivedAutomationRetentionDays).toBe(9)
    expect(second.getHostConfig().config.analyticsEnabled).toBe(false)
  })
})

// WHY: Funnel is the person's choice for the Serve mapping (plans/035 §0.8). Solus
// makes the mapping again after a restart or a repair, and it must come back with
// Funnel, or a cloud app loses the host without a sign. Turning Serve off ends it.
describe.serial('the Tailscale Funnel choice', () => {
  test('is stored with Serve, read back, and ends when Serve is turned off', async () => {
    const settings = await loadSettings('funnel-choice', { remoteAccess: 'any' })
    expect(settings.getServerSettings().tailscaleServe).toEqual({ enabled: false, port: 443, funnel: false })
    settings.setTailscaleServe(true, 443, true)
    const reread = await import(`../../packages/server/src/host/settings.ts?funnel-choice-reread`)
    expect(reread.getServerSettings().tailscaleServe).toEqual({ enabled: true, port: 443, funnel: true })
    reread.setTailscaleServe(false, 443, true)
    expect(reread.getServerSettings().tailscaleServe.funnel).toBe(false)
  })

  test('a file from before Funnel reads as Funnel off', async () => {
    const settings = await loadSettings('funnel-absent', { remoteAccess: 'any', tailscaleServe: { enabled: true, port: 8443 } })
    expect(settings.getServerSettings().tailscaleServe).toEqual({ enabled: true, port: 8443, funnel: false })
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
