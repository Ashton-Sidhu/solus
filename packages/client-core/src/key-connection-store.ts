import type { NativeSolusAPI, SolusAPI, AccountVaultResult } from '@solus/contracts/host-api'
import type { VaultKeyRef } from '@solus/contracts/vault-keys'

type HostKeys = Pick<SolusAPI, 'vaultKeyStatus' | 'vaultKeySave' | 'vaultKeyDisconnect'>
type AccountKeys = Pick<NativeSolusAPI, 'accountVault' | 'accountVaultSaveKey' | 'accountVaultDisconnect'>
export interface KeyConnectionState {
  location: 'host' | 'account' | 'none' | null
  connected: boolean
  label: string | null
  loading: boolean
  pending: boolean
  error: string | null
}
const initial = (): KeyConnectionState => ({
  location: null, connected: false, label: null, loading: false, pending: false, error: null
})

/** One key connection. The client writes its account; an unlinked host keeps its own key. */
export class KeyConnectionStore {
  #state = initial()
  #listeners = new Set<() => void>()
  #revision = 0
  constructor(
    readonly ref: VaultKeyRef,
    private readonly ports: {
      host: () => HostKeys
      /** Null when this client is signed out. Never fall back after an account failure. */
      account: () => AccountKeys | null
      identity: () => string
    }
  ) {}
  get current(): KeyConnectionState { return this.#state }
  subscribe = (changed: () => void): (() => void) => {
    this.#listeners.add(changed)
    return () => { this.#listeners.delete(changed) }
  }
  #set(patch: Partial<KeyConnectionState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const changed of this.#listeners) changed()
  }
  reset(): void {
    ++this.#revision
    this.#set(initial())
  }
  #applyAccount(result: AccountVaultResult): void {
    if (result.kind !== 'ok') {
      if (result.kind === 'signed-out') throw new Error('Sign in to Solus again to change this connection.')
      if (result.kind === 'offline') throw new Error('Your Solus account is offline. Try again when it connects.')
      throw new Error(result.message ?? 'Could not read your Solus account.')
    }
    const connection = result.connections.find(({ ref }) =>
      ref.kind === this.ref.kind && (ref.kind !== 'provider' || (this.ref.kind === 'provider' && ref.provider === this.ref.provider)))
    this.#set({ location: 'account', connected: connection?.status === 'connected', label: connection?.label ?? null })
  }
  async #run(action: 'read' | 'save' | 'disconnect', key?: string): Promise<boolean> {
    if (this.#state.pending || (action === 'read' && this.#state.loading)) return false
    const revision = ++this.#revision
    const identity = this.ports.identity()
    const current = () => revision === this.#revision && identity === this.ports.identity()
    this.#set({ loading: action === 'read', pending: action !== 'read', error: null })
    try {
      const account = this.ports.account()
      if (account) {
        this.#set({ location: 'account' })
        const result = action === 'save'
          ? await account.accountVaultSaveKey({ ref: this.ref, key: key!.trim() })
          : action === 'disconnect'
            ? await account.accountVaultDisconnect({ ref: this.ref })
            : await account.accountVault()
        if (!current()) return false
        this.#applyAccount(result)
      } else {
        const host = this.ports.host()
        const status = await host.vaultKeyStatus(this.ref)
        if (!current()) return false
        this.#set({ location: status.kind === 'unavailable' ? 'none' : status.kind, connected: status.kind === 'host' && status.connected, label: null })
        if (status.kind !== 'host')
          throw new Error(status.kind === 'account' ? 'Sign in to Solus to change this account connection.' : 'This connection is not available for this user.')
        if (action === 'save') await host.vaultKeySave({ ref: this.ref, key: key!.trim() })
        else if (action === 'disconnect') await host.vaultKeyDisconnect(this.ref)
        if (!current()) return false
        if (action !== 'read') this.#set({ connected: action === 'save' })
      }
      return true
    } catch (cause) {
      if (current()) this.#set({ error: cause instanceof Error ? cause.message : String(cause) })
      return false
    } finally {
      if (current()) this.#set({ loading: false, pending: false })
    }
  }
  load(): Promise<boolean> { return this.#run('read') }
  save(key: string): Promise<boolean> {
    if (!key.trim()) return Promise.resolve(false)
    return this.#run('save', key)
  }
  disconnect(): Promise<boolean> { return this.#run('disconnect') }
}
