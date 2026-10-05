import { cloudAccount, type CloudAgentSeat } from '@solus/client-core/cloud-account'
import { serverConnections } from '@solus/client-core/server-connections'
import { localApi } from '@solus/client-core/local-api'
import type { SeatProvider } from '@solus/contracts/seats'

/** Cloud connections belong to the account, even when no execution host is online. */
export class CloudAgentSeatsStore {
  seats = $state<CloudAgentSeat[] | null>(null)
  error = $state<string | null>(null)
  private pending: Promise<void> | null = null

  connected(provider: SeatProvider): boolean | null {
    return this.seats === null ? null : this.seats.some((seat) => seat.provider === provider && seat.connected)
  }

  async refresh(): Promise<void> {
    if (this.pending) return this.pending
    const account = cloudAccount()
    if (!account) {
      this.seats = null
      return
    }
    this.pending = (async () => {
      const seats = await account.readAgentSeats()
      if (cloudAccount() !== account) return
      if (seats !== null) {
        this.seats = seats
        this.error = null
      } else {
        this.error = 'Could not check your cloud agent connections. Try again.'
      }
    })().finally(() => { this.pending = null })
    return this.pending
  }

  /** Connection changes happen on the account page; returning to this view rechecks them. */
  watch(): () => void {
    void this.refresh()
    const onFocus = () => void this.refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }

  connect(): void {
    const url = cloudAccount()?.connectionsUrl
    if (url) void localApi.openExternal(url)
  }
}

/** Only managed hosts receive the account vault's logins; personal machines keep their own. */
export function usesCloudAgentSeats(serverId: string): boolean {
  return cloudAccount() !== null && serverConnections.connectionFor(serverId)?.target.uplink?.kind === 'managed'
}

export const cloudAgentSeatsStore = new CloudAgentSeatsStore()
