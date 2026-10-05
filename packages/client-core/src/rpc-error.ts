/**
 * A host's refusal, with the code the host put on the wire. The message is for
 * people; the code is what a surface branches on (`FORBIDDEN`, `SEAT_REQUIRED`).
 */
export class HostRpcError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'HostRpcError'
  }
}

/** The host's code on a rejected call, or nothing for a transport or client-side failure. */
export function rpcErrorCode(error: Error): string | undefined {
  return error instanceof HostRpcError ? error.code : undefined
}

/** The transport dropped or refused a call before a host answered it. A send
 *  that fails this way may be retried with the same id. */
export class TransportDisconnectedError extends Error {
  code = 'TRANSPORT_DISCONNECTED'

  constructor() {
    super('disconnected')
    this.name = 'TransportDisconnectedError'
  }
}
