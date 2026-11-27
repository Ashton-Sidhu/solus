import type { AnswerState } from '@solus/client-core/host-catalog'
import { readHostHealth } from '@solus/client-core/host-http'
import type { AppShortcutOffer, AppWindowWorkspaceRequest } from '@solus/contracts/app-shortcuts'

/** The host of an app window's app, as this client knows it now. */
export type AppWindowHost =
  /** This client has a connection id for the host. */
  | { kind: 'known'; serverId: string }
  /** The person's host list, or this computer's sign-in, is not read yet: the host can still be on it. */
  | { kind: 'finding' }
  /** The list was read, or its read failed, and it does not name the host. */
  | { kind: 'unknown'; reason: AppWindowHostGap }

/**
 * Why this computer does not know the host (docs/app-shortcuts.md §5). Only a
 * shortcut link tells the account apart: the client that made it was signed in.
 */
export type AppWindowHostGap =
  /** Solus here is signed in to another account than the link's. */
  | 'other-account'
  /** Solus here is signed out, and the link's host is on an account. */
  | 'signed-out'
  /** The host is not on this computer's host list. */
  | 'not-added'

/** This computer's sign-in, as far as the app window has read it. */
export interface AppWindowAccount {
  hasAnswered: boolean
  /** The subject of the account Solus here is signed in to; null when signed out. */
  subject: string | null
}

const APP_WINDOW_HOST_UNKNOWN_TEXT = 'This computer has no connection to the host of this app.'

/**
 * An app link names its host by installation id, which holds on every launch;
 * a connection id names a host only on this client. This computer's own host
 * is known at once. Another host is known when the person's host list names it.
 */
export function appWindowHost(
  knownHosts: ReadonlyArray<{ id: string; installationId?: string }>,
  listState: AnswerState,
  installationId: string,
  offer: AppShortcutOffer | null = null,
  account: AppWindowAccount = { hasAnswered: true, subject: null },
): AppWindowHost {
  const host = knownHosts.find((candidate) => candidate.installationId === installationId)
  if (host) return { kind: 'known', serverId: host.id }
  if (listState === 'loading') return { kind: 'finding' }
  if (offer?.account) {
    if (!account.hasAnswered) return { kind: 'finding' }
    if (!account.subject) return { kind: 'unknown', reason: 'signed-out' }
    if (account.subject !== offer.account) return { kind: 'unknown', reason: 'other-account' }
  }
  return { kind: 'unknown', reason: 'not-added' }
}

/** What the address of a shortcut link answers, read before the window offers to add that host. */
export type LinkAddressCheck = 'checking' | 'same-host' | 'other-host' | 'no-answer'

const ADDRESS_CHECK_TIMEOUT_MS = 5_000

/**
 * Reads `/health` at the link's address with no credential. Any page can
 * write the address, so the window offers to add that host only when it
 * answers with the installation id that the link names.
 */
export async function checkLinkAddress(
  fetchImpl: typeof fetch,
  address: string,
  installationId: string,
  signal: AbortSignal,
): Promise<Exclude<LinkAddressCheck, 'checking'>> {
  const timeout = AbortSignal.timeout(ADDRESS_CHECK_TIMEOUT_MS)
  const health = await readHostHealth(fetchImpl, address, AbortSignal.any([signal, timeout]))
  if (!health) return 'no-answer'
  return health.installationId === installationId ? 'same-host' : 'other-host'
}

/** What the window says, and the one thing it offers, for a host this computer does not know. */
export interface AppWindowHostGapView {
  title: string
  body: string
  action: { label: string; request: AppWindowWorkspaceRequest } | null
}

export function appWindowHostGapView(reason: AppWindowHostGap, address: string | null, check: LinkAddressCheck): AppWindowHostGapView {
  if (reason === 'other-account') {
    return {
      title: 'This app is on another Solus account.',
      body: 'Solus on this computer is signed in to another account. Sign in to the account that has this app, then choose Try again.',
      action: { label: 'Open account settings', request: { kind: 'account' } },
    }
  }
  if (reason === 'signed-out') {
    return {
      title: 'Sign in to open this app.',
      body: 'This app is on your Solus account. Sign in on this computer, then choose Try again.',
      action: { label: 'Sign in…', request: { kind: 'account' } },
    }
  }
  if (!address) {
    return {
      title: APP_WINDOW_HOST_UNKNOWN_TEXT,
      body: 'Add the host in Solus, then open this app again.',
      action: { label: 'Add host…', request: { kind: 'add-host', address: null } },
    }
  }
  const place = new URL(address).host
  if (check === 'checking') return { title: APP_WINDOW_HOST_UNKNOWN_TEXT, body: `Checking the host at ${place}…`, action: null }
  if (check === 'other-host') {
    return {
      title: 'Solus did not open this app.',
      body: `${place} answers as another host than the one this link names.`,
      action: null,
    }
  }
  if (check === 'no-answer') {
    return {
      title: 'Solus cannot reach the host of this app.',
      body: `${place} did not answer from this computer. Make sure the host runs and that this computer can reach it, then choose Try again.`,
      action: null,
    }
  }
  return {
    title: APP_WINDOW_HOST_UNKNOWN_TEXT,
    body: `Add the host at ${place} in Solus, then choose Try again.`,
    action: { label: 'Add host…', request: { kind: 'add-host', address } },
  }
}
