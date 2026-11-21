import type { HostListing } from '@solus/contracts/host-list'
import type { DirectoryHost, DirectoryWorkspace } from '@solus/contracts/uplink'
import { hostCatalog } from '@solus/client-core/host-catalog'
import type { KnownHost } from '@solus/client-core/known-host'
import { configureUplinkAccountSource } from '@solus/client-core/uplink-account'
import type { UplinkAccountSource } from '@solus/client-core/uplink-session'
import { fakeList, type Journal } from './host-catalog-world'

/**
 * The page's host catalog (`hostCatalog`), which the desktop and web stores wrap,
 * answered as a list read and a directory read would answer it (plans/033 §4.5).
 * The list is one fake source; each call answers it again with `listings`.
 */
export async function answerPageList(listings: HostListing[], journal: Journal = []) {
  const list = fakeList(journal, 'test', listings)
  await hostCatalog.useListSource(list.source)
  return list
}

/**
 * The hosts this page paired, as the catalog keeps them: each one's credential,
 * and its listing on a list that names only them. Replaces what an earlier call kept.
 */
export async function pairPageHosts(hosts: KnownHost[], journal: Journal = []) {
  const list = await answerPageList([], journal)
  for (const known of hostCatalog.hosts()) if (!hosts.some((host) => host.id === known.id)) await hostCatalog.forget(known.id).catch(() => {})
  for (const host of hosts) await hostCatalog.pair(host)
  return list
}

/** An account source whose directory lists these hosts and workspaces; the rest of the account answers nothing. */
export function directoryAccount(
  hosts: DirectoryHost[],
  workspaces: DirectoryWorkspace[] = [],
  overrides: Partial<UplinkAccountSource> = {},
): UplinkAccountSource {
  // SAFETY: the stores under test call only these members; the managed-host commands are not reached.
  return {
    listDirectory: async () => ({ directoryUrl: 'https://app.solus.test', hosts, workspaces }),
    accessToken: async () => null,
    isSignedOut: () => false,
    issueEnrollmentTicket: async () => null,
    loadOrganizationDirectory: async () => null,
    startManagedHost: async () => null,
    removeHost: async () => true,
    ...overrides,
  } as UplinkAccountSource
}

/** Configures the account with `account` (null: signed out) and reads the directory once. */
export async function answerPageDirectory(account: UplinkAccountSource | null): Promise<void> {
  configureUplinkAccountSource(account)
  await hostCatalog.refreshDirectory()
}
