import { formatDeviceError, type DeviceErrorCode } from '@solus/contracts/device-types'

/**
 * A device failure a client or agent can act on. The message crosses the RPC
 * boundary as `device_error:<code>: <prose>` (parseDeviceError), so the
 * code is stable and the prose never carries stack traces or host paths.
 */
export class DeviceDomainError extends Error {
  constructor(readonly code: DeviceErrorCode, readonly detail: string, cause?: unknown) {
    super(formatDeviceError(code, detail), cause === undefined ? undefined : { cause })
  }
}

/** The prose of any failure: the domain detail, or the error's own message. */
export function deviceErrorDetail(cause: unknown): string {
  if (cause instanceof DeviceDomainError) return cause.detail
  return cause instanceof Error ? cause.message : String(cause)
}
