import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OtelSettingsStore } from '../../src/renderer/contexts/projects/otel-settings.store.svelte'
import type { OtelSettings, OtelSettingsSnapshot } from '../../src/shared/types'

// A disposable data dir: these tests persist server settings, and the live
// ~/.solus holds the developer's real host configuration.
type SettingsModule = typeof import('../../src/main/server/settings')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let settings: SettingsModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-otel-settings-'))
  process.env.SOLUS_DATA_DIR = dataDir
  settings = await import('../../src/main/server/settings')
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('OTel host settings', () => {
  test('export is off until an endpoint says where to', () => {
    // A switch that reports "on" while exporting nowhere is a lying control,
    // so the endpoint is part of being enabled rather than a separate field.
    expect(settings.setOtelSettings({ enabled: true }).otel.enabled).toBe(false)
    expect(settings.setOtelSettings({ endpoint: 'https://otlp.example.com' }).otel.enabled).toBe(false)
    expect(settings.setOtelSettings({ enabled: true }).otel.enabled).toBe(true)
  })

  test('a pasted endpoint keeps its trailing slash out of the signal path', () => {
    // Signal paths are appended, so `https://host/` would ship to `host//v1/traces`.
    const saved = settings.setOtelSettings({ endpoint: '  https://otlp.example.com/  ' }).otel
    expect(saved.endpoint).toBe('https://otlp.example.com')
  })

  test('defaults ship every signal once export is on', () => {
    const saved = settings.setOtelSettings({ endpoint: 'https://otlp.example.com', enabled: true }).otel
    expect(saved).toMatchObject({ exportLogs: true, exportMetrics: true, exportTraces: true })
  })

  test('a signal can be turned off without turning export off', () => {
    const saved = settings.setOtelSettings({ exportLogs: false }).otel
    expect(saved).toMatchObject({ enabled: true, exportLogs: false, exportTraces: true })
  })

  test('settings reach disk, so they survive a restart of the host', () => {
    settings.setOtelSettings({ endpoint: 'https://otlp.example.com', enabled: true, exportMetrics: false })
    const persisted = JSON.parse(
      readFileSync(join(dataDir, 'server-settings.json'), 'utf-8'),
    ) as { otel?: OtelSettings }
    expect(persisted.otel).toMatchObject({
      enabled: true,
      endpoint: 'https://otlp.example.com',
      exportMetrics: false,
      exportTraces: true,
    })
  })
})

function snapshot(endpoint: string): OtelSettingsSnapshot {
  const otelSettings: OtelSettings = {
    enabled: true,
    endpoint,
    headers: '',
    exportLogs: true,
    exportMetrics: true,
    exportTraces: true,
  }
  return {
    settings: otelSettings,
    managedByEnvironment: false,
    active: { logs: true, metrics: true, traces: true },
  }
}

describe('OtelSettingsStore', () => {
  test('two hosts keep separate collectors', async () => {
    // The exporter runs beside each server, so one host exporting says nothing
    // about another the same user is connected to.
    const store = new OtelSettingsStore()
    const hostA = {
      serverId: 'host-a',
      api: {
        otelSettingsGet: async () => snapshot('https://a.example.com'),
        otelSettingsUpdate: async () => snapshot('https://a2.example.com'),
      },
    }
    const hostB = {
      serverId: 'host-b',
      api: {
        otelSettingsGet: async () => snapshot('https://b.example.com'),
        otelSettingsUpdate: async () => snapshot('https://b.example.com'),
      },
    }

    await Promise.all([store.load(hostA), store.load(hostB)])
    expect(store.snapshotFor('host-a')?.settings.endpoint).toBe('https://a.example.com')
    expect(store.snapshotFor('host-b')?.settings.endpoint).toBe('https://b.example.com')

    await store.update(hostA, { endpoint: 'https://a2.example.com' })
    expect(store.snapshotFor('host-a')?.settings.endpoint).toBe('https://a2.example.com')
    expect(store.snapshotFor('host-b')?.settings.endpoint).toBe('https://b.example.com')
  })

  test('a failed save reports on the host it failed for', async () => {
    const store = new OtelSettingsStore()
    const host = {
      serverId: 'host-c',
      api: {
        otelSettingsGet: async () => snapshot('https://c.example.com'),
        otelSettingsUpdate: async () => { throw new Error('Collector refused the endpoint.') },
      },
    }
    await store.load(host)
    await expect(store.update(host, { endpoint: 'nope' })).rejects.toThrow('Collector refused')
    expect(store.errorFor('host-c')).toBe('Collector refused the endpoint.')
    // The saved snapshot is untouched, so the form keeps showing what the host has.
    expect(store.snapshotFor('host-c')?.settings.endpoint).toBe('https://c.example.com')
  })
})
