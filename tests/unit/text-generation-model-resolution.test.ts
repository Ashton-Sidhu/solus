import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { join } from 'path'

const root = join(import.meta.dir, '../..')

describe('text-generation model resolution', () => {
  test('falls back from an unavailable source-control writer to the general model', () => {
    const script = String.raw`
      import { mock } from 'bun:test'
      import { mkdtempSync } from 'fs'
      import { tmpdir } from 'os'
      import { join } from 'path'

      process.env.SOLUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'solus-model-resolution-'))
      mock.module('./packages/server/src/cli-env', () => ({
        getCliPath: () => '/bin',
        findOnPath: (bin) => bin === 'codex' ? '/bin/codex' : null,
      }))

      const settings = await import('./packages/server/src/server/settings')
      settings.setHostConfig({
        textGenerationModel: { provider: 'codex', model: 'gpt-5.5' },
        sourceControlWriterModel: { provider: 'claude-code', model: 'claude-sonnet-5' },
      })
      console.log(JSON.stringify({
        configured: settings.getHostConfig().config.sourceControlWriterModel,
        effective: settings.resolveSourceControlWriterModel(),
      }))
    `
    const run = spawnSync(process.execPath, ['-e', script], {
      cwd: root,
      encoding: 'utf8',
    })

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    // SAFETY: The child script prints this exact test-owned JSON payload last.
    const output = JSON.parse(run.stdout.slice(run.stdout.lastIndexOf('\n{') + 1)) as {
      configured: { provider: string; model: string }
      effective: { provider: string; model: string }
    }
    expect(output.configured).toEqual({
      provider: 'claude-code',
      model: 'claude-sonnet-5',
    })
    expect(output.effective).toEqual({ provider: 'codex', model: 'gpt-5.5' })
  })

  test('falls back to the backup model when the preferred model is unavailable', () => {
    const script = String.raw`
      import { mock } from 'bun:test'
      import { mkdtempSync } from 'fs'
      import { tmpdir } from 'os'
      import { join } from 'path'

      process.env.SOLUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'solus-model-resolution-'))
      mock.module('./packages/server/src/cli-env', () => ({
        getCliPath: () => '/bin',
        findOnPath: (bin) => bin === 'claude' ? '/bin/claude' : null,
      }))

      const settings = await import('./packages/server/src/server/settings')
      settings.setHostConfig({
        textGenerationModel: { provider: 'codex', model: 'gpt-5.5' },
        backupTextGenerationModel: { provider: 'claude-code', model: 'claude-haiku-4-5-20251001' },
      })
      console.log(JSON.stringify({
        configured: settings.getHostConfig().config.textGenerationModel,
        effective: settings.resolveTextGenerationModel(),
        effectiveWriter: settings.resolveSourceControlWriterModel(),
      }))
    `
    const run = spawnSync(process.execPath, ['-e', script], {
      cwd: root,
      encoding: 'utf8',
    })

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    // SAFETY: The child script prints this exact test-owned JSON payload last.
    const output = JSON.parse(run.stdout.slice(run.stdout.lastIndexOf('\n{') + 1)) as {
      configured: { provider: string; model: string }
      effective: { provider: string; model: string }
      effectiveWriter: { provider: string; model: string }
    }
    const backup = { provider: 'claude-code', model: 'claude-haiku-4-5-20251001' }
    expect(output.configured).toEqual({ provider: 'codex', model: 'gpt-5.5' })
    expect(output.effective).toEqual(backup)
    expect(output.effectiveWriter).toEqual(backup)
  })
})
