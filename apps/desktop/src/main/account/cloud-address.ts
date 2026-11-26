import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { z } from 'zod'
import {
  parseCloudAddress,
  resolveCloudAddress,
  type CloudAddressChange,
  type CloudAddressState,
} from '@solus/contracts/cloud-address'

const storedCloudAddressSchema = z.object({ origin: z.string().min(1) })

/** The address the person chose for this device; null when the file is absent or is not one. */
function readStoredCloudAddress(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    return storedCloudAddressSchema.parse(JSON.parse(readFileSync(path, 'utf-8'))).origin
  } catch {
    return null
  }
}

/**
 * The Solus Cloud address of this computer (docs/solus-cloud-address.md): a file in
 * the app's own folder, beside the other settings of this device. `SOLUS_CLOUD_URL`
 * (development and staging) wins when it is set, and then the setting cannot change.
 * No file means the hosted address.
 */
export class DeviceCloudAddress {
  private state: CloudAddressState

  constructor(
    private readonly path: string,
    environment: string | undefined,
  ) {
    this.state = resolveCloudAddress({ environment, setting: readStoredCloudAddress(path) })
  }

  current(): CloudAddressState {
    return this.state
  }

  /**
   * Changes the address; `null` goes back to the hosted one. The account session
   * moves first, because it refuses while it holds a sign-in. A choice this computer
   * cannot keep is not applied: the session moves back.
   */
  change(input: string | null, session: { useCloudOrigin(origin: string): boolean }): CloudAddressChange {
    if (this.state.source === 'environment') return { ok: false, refusal: 'environment' }
    if (input !== null) {
      const parsed = parseCloudAddress(input)
      if (!parsed.ok) return parsed
    }
    const next = resolveCloudAddress({ setting: input })
    if (!session.useCloudOrigin(next.origin)) return { ok: false, refusal: 'signed-in' }
    try {
      if (next.source === 'setting') writeFileSync(this.path, JSON.stringify({ origin: next.origin }, null, 2), { mode: 0o600 })
      else if (existsSync(this.path)) unlinkSync(this.path)
    } catch {
      session.useCloudOrigin(this.state.origin)
      return { ok: false, refusal: 'not-saved' }
    }
    this.state = next
    return { ok: true, address: next }
  }
}
