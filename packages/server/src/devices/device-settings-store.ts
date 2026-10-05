import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sshDeviceHostConfigsSchema, type DeviceSettingsState } from '@solus/contracts/device-types'
import { createLogger } from '../logger'

const log = createLogger('devices', 'device-settings-store.ts')

/** A stored file is read field by field; an unreadable field falls back alone. */
const storedSettingsSchema = z.object({
  enabled: z.boolean().catch(false),
  // On unless the person turned it off; it acts only while device support is on.
  agentAccessEnabled: z.boolean().catch(true),
  onboardingCompleted: z.boolean().catch(false),
  autoShowAgentDevices: z.boolean().catch(true),
  sshHosts: sshDeviceHostConfigsSchema.catch([]),
})

export const DEFAULT_DEVICE_SETTINGS: DeviceSettingsState = {
  enabled: false,
  agentAccessEnabled: true,
  onboardingCompleted: false,
  autoShowAgentDevices: true,
  sshHosts: [],
}

/**
 * Host-owned device settings, in their own 0600 file. They never travel in
 * transcript records; SSH identity paths stay on the host.
 */
export class DeviceSettingsStore {
  private value: DeviceSettingsState

  constructor(private readonly path: string) {
    this.value = this.load()
  }

  get(): DeviceSettingsState {
    return { ...this.value, sshHosts: this.value.sshHosts.map((host) => ({ ...host })) }
  }

  private load(): DeviceSettingsState {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      return { ...DEFAULT_DEVICE_SETTINGS }
    }
    try {
      const parsed = storedSettingsSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) return { ...DEFAULT_DEVICE_SETTINGS }
      return parsed.data
    } catch (cause) {
      log.warn('device_settings_unreadable', { error: cause instanceof Error ? cause.message : String(cause) })
      return { ...DEFAULT_DEVICE_SETTINGS }
    }
  }

  async update(patch: Partial<DeviceSettingsState>): Promise<DeviceSettingsState> {
    const next = { ...this.value, ...patch }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
    await rename(temporary, this.path)
    this.value = next
    return this.get()
  }
}
