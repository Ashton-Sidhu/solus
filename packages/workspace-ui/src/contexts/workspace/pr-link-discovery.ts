export interface PrLinkDiscoveryInput {
  taskId: string
  serverId: string
  projectKey: string
  prNumber: number | null
  branches: (string | null)[]
  originSessionId: string | null
}

/** The stable inputs that can change which PR belongs to a sidebar task. */
export function prLinkDiscoveryKey(inputs: PrLinkDiscoveryInput[]): string {
  return JSON.stringify(inputs.toSorted((a, b) =>
    a.serverId.localeCompare(b.serverId)
      || a.projectKey.localeCompare(b.projectKey)
      || a.taskId.localeCompare(b.taskId),
  ))
}
