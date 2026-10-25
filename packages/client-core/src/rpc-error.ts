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

  constructor(message = 'disconnected') {
    super(message)
    this.name = 'TransportDisconnectedError'
  }
}

/** A call to a host this client does not know: it was deleted, or it was never
 *  listed here (docs/plans/workspace-and-machines.md §6). Readers that already
 *  handle a host that is away handle it the same way; a retry will not help. */
export class HostGoneError extends TransportDisconnectedError {
  constructor(readonly serverId: string) {
    super(`The host ${serverId} was removed`)
    this.name = 'HostGoneError'
  }
}

/** A call to a host past its grace (docs/plans/host-readiness.md). The send
 *  outbox treats it as transient: the host may answer again. */
export class HostUnreachableError extends TransportDisconnectedError {
  constructor(readonly serverId: string) {
    super(`The host ${serverId} is unreachable`)
    this.name = 'HostUnreachableError'
  }
}
