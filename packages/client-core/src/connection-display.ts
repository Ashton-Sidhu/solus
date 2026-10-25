export interface ConnectionFailureCopy {
  title: string
  /** Names the likely cause and what to do about it. */
  detail: string
}

/**
 * socket.io reports failures as mechanism strings — "xhr poll error",
 * "websocket error", "timeout". Each names the layer that gave up, never a
 * reason the user can act on, so lead with a cause and keep the raw text for
 * the details block.
 */
export function describeConnectionFailure(hostLabel: string, error: Parameters<typeof String>[0]): ConnectionFailureCopy {
  const message = error instanceof Error ? error.message : String(error)
  if (/token|unauthori[sz]ed/i.test(message)) {
    return {
      title: `${hostLabel} needs pairing again`,
      detail: 'The saved session token was rejected. Pair with this host again to pick up where you left off.',
    }
  }
  if (/bridge is unavailable/i.test(message)) {
    return {
      title: 'Solus could not start',
      detail: 'The desktop bridge did not load. Restarting Solus usually clears this.',
    }
  }
  return {
    title: `Solus can't reach ${hostLabel}`,
    detail: 'The host did not answer. It may be asleep, or no longer on this network.',
  }
}
