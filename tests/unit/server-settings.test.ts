import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const originalDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string | undefined

afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  dataDir = undefined
  if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = originalDataDir
})

interface PersistedSettingsFixture {
  remoteAccess?: boolean
  agentTaskLifecyclePolicy?: string
  name?: string
}

async function loadSettings(name: string, persisted?: PersistedSettingsFixture) {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-server-settings-'))
  process.env.SOLUS_DATA_DIR = dataDir
  if (persisted) writeFileSync(join(dataDir, 'server-settings.json'), JSON.stringify(persisted))
  return import(`../../packages/server/src/server/settings.ts?${name}`)
}

describe.serial('server settings defaults', () => {
  test('allows remote connections for a new installation', async () => {
    const settings = await loadSettings('new-installation')
    expect(settings.getServerSettings().remoteAccess).toBe(true)
    expect(settings.getHostConfig().config.agentTaskLifecyclePolicy).toBe('moderate')
    expect(settings.getHostConfig().config.textGenerationModel).toEqual({
      provider: 'codex',
      model: 'gpt-5.6-luna',
    })
    expect(settings.getHostConfig().config.backupTextGenerationModel).toEqual({
      provider: 'claude-code',
      model: 'claude-haiku-4-5-20251001',
    })
    expect(settings.getHostConfig().config.sourceControlWriterModel).toBeNull()
    expect(settings.getHostConfig().config.sourceControlWriting).toEqual({
      mode: 'repo_conventions',
      customInstructions: '',
      followPullRequestTemplate: true,
    })
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

  test('loads a persisted autonomous task lifecycle policy', async () => {
    const settings = await loadSettings('autonomous-task-lifecycle', {
      remoteAccess: true,
      agentTaskLifecyclePolicy: 'autonomous',
    })
    expect(settings.getHostConfig().config.agentTaskLifecyclePolicy).toBe('autonomous')
  })

  test('uses moderate for missing or invalid task lifecycle policies', async () => {
    const settings = await loadSettings('invalid-task-lifecycle', {
      remoteAccess: true,
      agentTaskLifecyclePolicy: 'unrestricted',
    })
    expect(settings.getHostConfig().config.agentTaskLifecyclePolicy).toBe('moderate')
  })

  test('persists the general writer and optional source-control override', async () => {
    const settings = await loadSettings('text-generation-models')
    settings.setHostConfig({
      textGenerationModel: { provider: 'claude-code', model: 'claude-sonnet-5' },
      sourceControlWriterModel: { provider: 'codex', model: 'gpt-5.5' },
      sourceControlWriting: {
        mode: 'custom',
        customInstructions: 'Use imperative titles and include a Risks section.',
        followPullRequestTemplate: false,
      },
    })

    // SAFETY: This test reads the exact JSON object written by the settings module.
    const saved = (JSON.parse(
      readFileSync(join(dataDir!, 'server-settings.json'), 'utf8'),
    ) as {
      hostConfig: {
        textGenerationModel: { provider: string; model: string }
        sourceControlWriterModel: { provider: string; model: string } | null
        sourceControlWriting: {
          mode: string
          customInstructions: string
          followPullRequestTemplate: boolean
        }
      }
    }).hostConfig
    expect(saved.textGenerationModel).toEqual({
      provider: 'claude-code',
      model: 'claude-sonnet-5',
    })
    expect(saved.sourceControlWriterModel).toEqual({ provider: 'codex', model: 'gpt-5.5' })
    expect(saved.sourceControlWriting).toEqual({
      mode: 'custom',
      customInstructions: 'Use imperative titles and include a Risks section.',
      followPullRequestTemplate: false,
    })

    settings.setHostConfig({ sourceControlWriterModel: null })
    expect(settings.getHostConfig().config.sourceControlWriterModel).toBeNull()
  })
})
