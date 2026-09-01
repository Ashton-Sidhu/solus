export interface PrNavigationTargetInput {
  /** The host this client uses for its normal RPC surface. */
  clientServerId: string
  projectDirectory: string
  /** Competing host identities are explicit so this policy cannot drift back to
   * either task ownership or attempt execution. */
  taskServerId: string | null
  attemptServerId: string | null
}

export interface PrNavigationTarget {
  serverId: string
  projectDirectory: string
  paneTarget: 'aside'
}

/**
 * A PR chip is client navigation. Task ownership and execution placement must
 * not move that surface to another host.
 */
export function prNavigationTarget(input: PrNavigationTargetInput): PrNavigationTarget {
  return {
    serverId: input.clientServerId,
    projectDirectory: input.projectDirectory,
    paneTarget: 'aside',
  }
}
