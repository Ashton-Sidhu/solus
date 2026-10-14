import { getContext, setContext } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import { hostKey } from '@solus/client-core/host-key'
import { serverConnections } from '@solus/client-core/server-connections'
import { githubMediaFetchUrl } from '@solus/contracts/github-media'
import type { AssetCreateUrlResult } from '@solus/contracts/rpc'

/**
 * Images and videos in a pull request body that live on GitHub. In a private
 * repository GitHub answers them only with a credential, which a client does
 * not have. A host with `githubMediaUrls` fetches them with its own and gives
 * a signed URL. Anything else, or a host that refuses (a collaboration-only
 * host), loads the URL as the author wrote it.
 */

/** Mint a new URL this long before the old one expires. */
export const GITHUB_MEDIA_REFRESH_WINDOW_MS = 60_000

export interface GithubMediaSigner {
  /** True when the host signs GitHub media (`githubMediaUrls`). */
  signs: (serverId: string) => Promise<boolean>
  mint: (serverId: string, githubMediaUrl: string) => Promise<AssetCreateUrlResult>
  /** The HTTP origin this client opens the host's assets on. */
  origin: (serverId: string) => string
}

type GithubMediaEntry =
  | { status: 'pending' }
  | { status: 'ready'; url: string; expiresAt: number }
  | { status: 'refused' }

export class GithubMediaSources {
  readonly #entries = new SvelteMap<string, GithubMediaEntry>()
  readonly #signer: GithubMediaSigner
  readonly #now: () => number

  constructor(signer: GithubMediaSigner, now: () => number = Date.now) {
    this.#signer = signer
    this.#now = now
  }

  /**
   * The source to draw: the signed URL while it is valid, the author's URL
   * when the host cannot sign it, and null while the first signature is on its
   * way (so a private image does not flash broken first).
   */
  sourceFor(serverId: string, source: string): string | null {
    const entry = this.#entries.get(hostKey(serverId, source))
    if (!entry) return null
    if (entry.status === 'refused') return source
    if (entry.status === 'ready' && entry.expiresAt > this.#now()) return entry.url
    return null
  }

  /** Sign `source` unless a valid URL or a signature on its way is held. */
  request(serverId: string, source: string): void {
    const key = hostKey(serverId, source)
    const entry = this.#entries.get(key)
    if (entry?.status === 'pending' || entry?.status === 'refused') return
    if (entry?.status === 'ready' && entry.expiresAt - this.#now() > GITHUB_MEDIA_REFRESH_WINDOW_MS) return
    if (!githubMediaFetchUrl(source)) {
      this.#entries.set(key, { status: 'refused' })
      return
    }
    // A URL near its end stays on screen until the new one arrives.
    if (entry?.status !== 'ready') this.#entries.set(key, { status: 'pending' })
    void this.#mint(key, serverId, source)
  }

  /** The signed URL did not load. Show the author's URL from now on. */
  refuse(serverId: string, source: string): void {
    this.#entries.set(hostKey(serverId, source), { status: 'refused' })
  }

  async #mint(key: string, serverId: string, source: string): Promise<void> {
    try {
      if (!(await this.#signer.signs(serverId))) throw new Error('The host does not sign GitHub media.')
      const minted = await this.#signer.mint(serverId, source)
      const origin = this.#signer.origin(serverId)
      if (!origin) throw new Error('The host has no origin.')
      const url = new URL(minted.relativeUrl, `${origin.replace(/\/+$/, '')}/`).toString()
      this.#entries.set(key, { status: 'ready', url, expiresAt: minted.expiresAt })
    } catch {
      this.#entries.set(key, { status: 'refused' })
    }
  }
}

export const githubMediaSources = new GithubMediaSources({
  signs: async (serverId) => (await serverConnections.capabilitiesFor(serverId)).githubMediaUrls === true,
  mint: (serverId, githubMediaUrl) => serverConnections.apiFor(serverId).prMediaUrl(undefined, githubMediaUrl),
  origin: (serverId) => serverConnections.httpOriginFor(serverId),
})

const KEY = Symbol('github-media-host')

/** Set by a pull request surface: its markdown signs GitHub media on this host. */
export function setGithubMediaHost(serverId: () => string | null): void {
  setContext(KEY, serverId)
}

/** The host to sign GitHub media on, or null outside a pull request surface. */
export function getGithubMediaHost(): (() => string | null) | null {
  return getContext<(() => string | null) | undefined>(KEY) ?? null
}
