import type { KeyConnectionState } from '@solus/client-core/key-connection-store'
import { hosts } from '../../../../contexts/hosts/hosts.svelte'
import { keyConnectionFor } from '../../../settings/key-connections.store'

const LINEAR_REF = { kind: 'provider', provider: 'linear' } as const

/**
 * The person's Linear key on the task host, for the menu that adds a source
 * and its connect dialog: a person connects Linear there and picks a team
 * without going to Settings.
 * The key goes where Settings › Integrations puts it: the account when signed
 * in, else the host (`KeyConnectionStore`).
 */
export class MenuLinearKey {
  /** The last state `watch` saw; null until it runs. */
  #seen = $state<KeyConnectionState | null>(null)
  readonly connection

  constructor(readonly serverId: string) {
    this.connection = keyConnectionFor(serverId, LINEAR_REF)
  }

  get state(): KeyConnectionState {
    return this.#seen ?? this.connection.current
  }

  /** Follows the connection until the returned stop runs. */
  watch(): () => void {
    this.#seen = this.connection.current
    return this.connection.subscribe(() => { this.#seen = this.connection.current })
  }

  /** Whether this person may save a key from the menu: in their account, or on a host they administer. */
  get canSave(): boolean {
    if (this.state.location === 'account') return true
    return this.state.location === 'host' && hosts.get(this.serverId).me.may('host.admin.connections')
  }
}
