/**
 * The order of the host picker on a settings page that shows one host: the host
 * of the current session, then the host on this device, then the other connected
 * hosts in connection order (docs/plans/settings-sync-hosts.md decision 7). A
 * lead host that is not connected is left out.
 */
export function settingsHostOrder(connectedIds: readonly string[], leadIds: readonly (string | null | undefined)[]): string[] {
  const leads = leadIds.filter((serverId): serverId is string => !!serverId && connectedIds.includes(serverId))
  return [...new Set([...leads, ...connectedIds])]
}

/**
 * The host the page shows: the first asked host that is listed (the host a link
 * names, then the host the person picked), else the first host of the order.
 * The first connection is only the host that answered first, so it never leads.
 */
export function chosenSettingsHostId(orderedIds: readonly string[], askedIds: readonly (string | null | undefined)[]): string | null {
  return askedIds.find((serverId): serverId is string => !!serverId && orderedIds.includes(serverId)) ?? orderedIds[0] ?? null
}
