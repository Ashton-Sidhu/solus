import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OtelSettingsStore } from '@solus/workspace-ui/contexts/projects/otel-settings.store.svelte'
import { DEFAULT_HOST_CONFIG } from '@solus/contracts/host-config'
import type { HostConfigSnapshot } from '@solus/contracts/host-config'
import type { OtelSettings, OtelSettingsSnapshot } from '@solus/contracts/types'

// A disposable data dir: these tests persist server settings, and the live
// ~/.solus holds the developer's real host configuration.
type SettingsModule = typeof import('@solus/server/server/settings')

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let settings: SettingsModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-otel-settings-'))
  process.env.SOLUS_DATA_DIR = dataDir
  settings = await import('@solus/server/server/settings')
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

/** Otel settings are host config now, so they go through the one config write.
 *  A partial patch merges onto the current value, which is what lets the panel
 *  toggle one switch without blanking the endpoint beside it. */
const setOtel = (patch: Partial<OtelSettings>): OtelSettings =>
  settings.setHostConfig({ otel: patch }).config.otel

describe('OTel host settings', () => {
  test('export is off until an endpoint says where to', () => {
    // A switch that reports "on" while exporting nowhere is a lying control,
    // so the endpoint is part of being enabled rather than a separate field.
    expect(setOtel({ enabled: true }).enabled).toBe(false)
    expect(setOtel({ endpoint: 'https://otlp.example.com' }).enabled).toBe(false)
    expect(setOtel({ enabled: true }).enabled).toBe(true)
  })

  test('a pasted endpoint keeps its trailing slash out of the signal path', () => {
    // Signal paths are appended, so `https://host/` would ship to `host//v1/traces`.
    expect(setOtel({ endpoint: '  https://otlp.example.com/  ' }).endpoint).toBe('https://otlp.example.com')
  })

  test('defaults ship every signal once export is on', () => {
    const saved = setOtel({ endpoint: 'https://otlp.example.com', enabled: true })
    expect(saved).toMatchObject({ exportLogs: true, exportMetrics: true, exportTraces: true })
  })

  test('a signal can be turned off without turning export off', () => {
    const saved = setOtel({ exportLogs: false })
    expect(saved).toMatchObject({ enabled: true, exportLogs: false, exportTraces: true })
  })

  test('settings reach disk, so they survive a restart of the host', () => {
    setOtel({ endpoint: 'https://otlp.example.com', enabled: true, exportMetrics: false })
    const persisted = JSON.parse(
      readFileSync(join(dataDir, 'server-settings.json'), 'utf-8'),
    ) as { hostConfig?: { otel?: OtelSettings } }
    expect(persisted.hostConfig?.otel).toMatchObject({
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

/** `configUpdate` answers with host config; the store ignores it and re-reads
 *  the computed snapshot, so its exact contents do not matter here. */
const configSnapshot = (): HostConfigSnapshot => ({ config: DEFAULT_HOST_CONFIG, seeded: true })

describe('OtelSettingsStore', () => {
  test('two hosts keep separate collectors', async () => {
    // The store writes through `configUpdate` and then re-reads, because which
    // signals are actually exporting is runtime state the patch cannot report.
    let endpointA = 'https://a.example.com'
    // The exporter runs beside each server, so one host exporting says nothing
    // about another the same user is connected to.
    const store = new OtelSettingsStore()
    const hostA = {
      serverId: 'host-a',
      api: {
        otelSettingsGet: async () => snapshot(endpointA),
        configUpdate: async () => { endpointA = 'https://a2.example.com'; return configSnapshot() },
      },
    }
    const hostB = {
      serverId: 'host-b',
      api: {
        otelSettingsGet: async () => snapshot('https://b.example.com'),
        configUpdate: async () => configSnapshot(),
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
        configUpdate: async () => { throw new Error('Collector refused the endpoint.') },
      },
    }
    await store.load(host)
    await expect(store.update(host, { endpoint: 'nope' })).rejects.toThrow('Collector refused')
    expect(store.errorFor('host-c')).toBe('Collector refused the endpoint.')
    // The saved snapshot is untouched, so the form keeps showing what the host has.
    expect(store.snapshotFor('host-c')?.settings.endpoint).toBe('https://c.example.com')
  })
})
